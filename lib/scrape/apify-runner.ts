import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Run an Apify search job from the server.
 *
 * This used to live on the VM: worker.py claimed a job tagged
 * scrape_source='apify' and called the Apify API itself. So the VMs were not
 * an alternative to Apify — they were its dispatcher, and when the AWS
 * account was suspended on 14 October every kind of scrape stopped, Apify
 * included.
 *
 * Ported from vm/worker.py's `process_apify_organic_job` and its helpers. The
 * behaviour is deliberately the same, with one exception: there is no VM left
 * to hand an empty result off to, so an empty run now fails retryably instead.
 */

const GOOGLE_ACTOR = 'apify~google-search-scraper'
const BING_ACTOR = 'tri_angle~bing-search-scraper'

export type ScrapeJob = {
  id: string
  keyword: string
  country_code: string | null
  search_engine: string | null
  pages: number | null
  attempts: number | null
}

type ResultRow = {
  url: string
  full_url: string
  title: string
  description: string
  resultType: 'Organic' | 'PPC'
  page: number
  position: number
  overall_position: number
  keyword: string
  seen_on: 'desktop'
}

/** Env first, then system_settings — the key survives a redeploy either way. */
export async function resolveApifyToken(): Promise<string | null> {
  const env = (process.env.APIFY_TOKEN ?? '').trim()
  if (env) return env
  const svc = createServiceClient()
  const { data } = await svc
    .from('system_settings')
    .select('value')
    .eq('key', 'apify_api_token')
    .maybeSingle()
  const v = (data as { value?: unknown } | null)?.value
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * Start a run, poll it, then read its dataset.
 *
 * Not run-sync-get-dataset-items: that holds one HTTP request open for the
 * whole run, and deep runs routinely blow past its window and the
 * concurrent-sync-run limit. The async API waits them out — a cheap start
 * call, short polls, then a plain dataset read.
 */
async function runAndFetch(
  actor: string,
  input: Record<string, unknown>,
  token: string,
  maxWaitMs = 200_000,
): Promise<{ ok: boolean; items: Array<Record<string, unknown>> }> {
  try {
    // Apify caps concurrent runs per plan. A submitted batch can start
    // several at once, so wait for a slot rather than failing the job.
    let start: Response | null = null
    for (let i = 0; i < 4; i++) {
      start = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (start.ok) break
      await sleep(6000)
    }
    if (!start?.ok) {
      console.error('[apify] run start failed', start?.status)
      return { ok: false, items: [] }
    }

    const started = (await start.json()) as { data?: { id?: string; defaultDatasetId?: string; status?: string } }
    const runId = started.data?.id
    const datasetId = started.data?.defaultDatasetId
    let status = started.data?.status ?? 'READY'
    if (!runId || !datasetId) return { ok: false, items: [] }

    const deadline = Date.now() + maxWaitMs
    while ((status === 'READY' || status === 'RUNNING') && Date.now() < deadline) {
      await sleep(3000)
      try {
        const poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`)
        if (poll.ok) {
          const j = (await poll.json()) as { data?: { status?: string } }
          status = j.data?.status ?? status
        }
      } catch (e) {
        console.error('[apify] poll error', runId, e)
      }
    }
    if (status !== 'SUCCEEDED') {
      console.error('[apify] run ended', runId, status)
      return { ok: false, items: [] }
    }

    const items = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true`,
    )
    if (!items.ok) {
      console.error('[apify] dataset fetch failed', items.status, runId)
      return { ok: false, items: [] }
    }
    const payload = await items.json()
    return { ok: true, items: Array.isArray(payload) ? payload : [] }
  } catch (e) {
    console.error('[apify] run error', e)
    return { ok: false, items: [] }
  }
}

/** Google gives clean urls; Bing wraps them in a redirect but exposes the real
 *  site in displayedUrl ("https://host › path › …"), so rebuild from that. */
function urlAndDomain(engine: string, o: Record<string, unknown>): [string | null, string | null] {
  const parse = (s: string): URL | null => {
    try {
      const u = new URL(s)
      return u.protocol && u.host ? u : null
    } catch {
      return null
    }
  }
  if (engine === 'bing') {
    const disp = String(o.displayedUrl ?? '').trim()
    if (!disp) return [null, null]
    const u = parse(disp.split('›')[0]!.trim())
    if (!u) return [null, null]
    return [disp.replace(/\s*›\s*/g, '/'), `${u.protocol}//${u.host}`]
  }
  const raw = String(o.url ?? '').trim()
  if (!raw) return [null, null]
  const u = parse(raw)
  return u ? [raw, `${u.protocol}//${u.host}`] : [null, null]
}

function parseOrganic(items: Array<Record<string, unknown>>, engine: string, keyword: string): ResultRow[] {
  const out: ResultRow[] = []
  const seen = new Set<string>()
  items.forEach((page, pageIdx) => {
    for (const o of (page.organicResults as Array<Record<string, unknown>>) ?? []) {
      if (!o || typeof o !== 'object') continue
      const [url, full] = urlAndDomain(engine, o)
      if (!url || !full || seen.has(url)) continue
      seen.add(url)
      out.push({
        url,
        full_url: full,
        title: String(o.title ?? ''),
        // complete_scrape_job stores this as serp_description and the
        // relevance screen reads it. Actor versions name it either way.
        description: String(o.description ?? o.snippet ?? ''),
        resultType: 'Organic',
        page: pageIdx + 1,
        position: out.length + 1,
        overall_position: out.length + 1,
        keyword,
        seen_on: 'desktop',
      })
    }
  })
  return out
}

/** Only Bing's paidResults are usable — Google mashes several advertisers into
 *  one displayedUrl, and its gambling ads are policy-blocked anyway. */
function parsePaid(items: Array<Record<string, unknown>>, keyword: string): ResultRow[] {
  const out: ResultRow[] = []
  const seen = new Set<string>()
  items.forEach((page, pageIdx) => {
    for (const o of (page.paidResults as Array<Record<string, unknown>>) ?? []) {
      if (!o || typeof o !== 'object') continue
      const disp = String(o.displayedUrl ?? '').trim()
      if (!disp) continue
      let base = disp.split('›')[0]!.trim()
      // Google sometimes mangles this as "https://Ahttps://B" — take the last
      // scheme so we land on the true destination.
      const cut = Math.max(base.lastIndexOf('https://'), base.lastIndexOf('http://'))
      if (cut > 0) base = base.slice(cut)
      let u: URL
      try {
        u = new URL(base)
      } catch {
        continue
      }
      const host = u.host
      if (!host || !host.includes('.') || host.toLowerCase().includes('http')) continue
      const key = host.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const full = `${u.protocol}//${host}`
      out.push({
        url: full,
        full_url: full,
        title: String(o.title ?? ''),
        description: String(o.description ?? o.snippet ?? ''),
        resultType: 'PPC',
        page: pageIdx + 1,
        position: out.length + 1,
        overall_position: out.length + 1,
        keyword,
        seen_on: 'desktop',
      })
    }
  })
  return out
}

export type RunOutcome =
  | { status: 'completed'; organic: number; paid: number }
  | { status: 'failed'; reason: string }

export async function runApifyJob(job: ScrapeJob): Promise<RunOutcome> {
  const svc = createServiceClient()
  const engine = (job.search_engine ?? 'google').trim().toLowerCase()
  const keyword = job.keyword
  const country = (job.country_code ?? '').trim().toLowerCase()
  const pages = Math.max(1, Number(job.pages ?? 1))
  const actor = engine === 'bing' ? BING_ACTOR : GOOGLE_ACTOR

  const token = await resolveApifyToken()
  if (!token) {
    return { status: 'failed', reason: "Apify isn't configured yet (missing API token). Tell a developer." }
  }

  let organic: ResultRow[] = []
  let paid: ResultRow[] = []
  let sawSuccess = false

  // Bing's paid count swings run-to-run for the same query, so keep retrying
  // to catch ads even once organic is in hand. Google's casino ads are
  // policy-blocked, so don't burn retries chasing them.
  const wantAds = engine === 'bing'
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { ok, items } = await runAndFetch(
      actor,
      {
        queries: keyword,
        countryCode: country,
        resultsPerPage: 10,
        maxPagesPerQuery: pages,
        mobileResults: false,
        saveHtml: false,
      },
      token,
    )
    if (ok) {
      sawSuccess = true
      const o = parseOrganic(items, engine, keyword)
      const p = engine === 'bing' ? parsePaid(items, keyword) : []
      if (o.length > organic.length) organic = o
      if (p.length > paid.length) paid = p
    }
    if (organic.length > 0 && (paid.length > 0 || !wantAds)) break
    if (attempt < 3) await sleep(2000)
  }

  const results = [...organic, ...paid]
  if (results.length === 0) {
    // The VM used to take these — restricted markets and obscure queries where
    // the actor returns nothing. There is no VM now, so this fails retryably
    // and an operator can re-run it.
    return {
      status: 'failed',
      reason: sawSuccess
        ? 'The search returned no results for this keyword and country. Try re-running it.'
        : 'The search service had a hiccup — hit Retry if it persists.',
    }
  }

  // Bing's job carries organic AND paid, so clear the 'Organic' filter or the
  // batch view would hide the PPC rows.
  if (engine === 'bing') {
    await svc.from('scrape_queue').update({ result_type_filter: null }).eq('id', job.id)
  }

  const summary = {
    source: 'apify',
    engine,
    // Google PPC used to arrive later from a sibling VM job. That job no
    // longer exists, so nothing is pending.
    ppc_pending: false,
    organic_results: organic.length,
    ppc_results: paid.length,
  }

  const { error } = await svc.rpc('complete_scrape_job', {
    p_job_id: job.id,
    p_results: results,
    p_summary: summary,
  })
  if (error) {
    console.error('[apify] complete_scrape_job failed', job.id, error.message)
    return { status: 'failed', reason: "The results couldn't be saved — retrying." }
  }

  return { status: 'completed', organic: organic.length, paid: paid.length }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
