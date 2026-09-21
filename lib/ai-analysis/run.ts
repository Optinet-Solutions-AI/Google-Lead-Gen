import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  audit,
  auditInstructions,
  brandFromLabel,
  brandSlug,
  contactPageCandidate,
  ctaCandidates,
  fetchPage,
  hostOf,
  isOutboundCta,
  triage,
  unmask,
  type Brand,
  type PageLink,
} from './core'
import { runRelevanceForJobs, type RelevanceRunResult } from './relevance'

/**
 * Orchestrates the AI stage for websites that survived the trim
 * (not on Monday, not not-relevant, no system flag).
 *
 *   1. TRIAGE   cheap, no fetch — is this worth opening?
 *   2. AUDIT    we curl the page (and its contact page), the model judges it
 *   3. CTA      we extract + resolve the links in code
 *   4. HAND OFF confirmed affiliates with CTA links are queued for the VM's
 *               existing browser S-tag stage, which is the only thing that
 *               can complete a JavaScript redirect, read a tag dropped as a
 *               cookie, or reach a geo-gated operator via the country's
 *               residential exit.
 */

export type AiRunOptions = {
  /** Restrict to specific scrape jobs. Otherwise recent completed jobs. */
  jobIds?: string[]
  countryCode?: string
  /** How far back to look for completed jobs when jobIds is absent. */
  days?: number
  /** Max sites to screen and max sites to audit in this run. */
  triageLimit?: number
  auditLimit?: number
  /** Stop auditing once this much has been spent in the run. */
  budgetUsd?: number
  concurrency?: number
  /** Skip the DB writes (rehearsal). */
  dryRun?: boolean
  onProgress?: (msg: string) => void
}

export type AiRunResult = {
  ok: boolean
  skipped?: string
  /** Stage 0: how many SERP results were judged against their keyword. */
  relevance?: RelevanceRunResult
  candidates: number
  screened: number
  shortlisted: number
  audited: number
  fetchOk: number
  affiliates: number
  ctaLinks: number
  ctaViaRoosterTracker: number
  roosterSites: number
  stagQueued: number
  contactPages: number
  costUsd: number
  ms: number
  errors?: string[]
}

type Candidate = {
  profile_id: number
  lead_id: number
  normalized_domain: string
  url: string
  keyword: string | null
  country_code: string | null
  ai_screened_at: string | null
  ai_worth_checking: boolean | null
  ai_crawl_at: string | null
}

async function setting<T>(svc: SupabaseClient, key: string, fallback: T): Promise<T> {
  const { data } = await svc.rpc('get_system_setting', { p_key: key })
  return (data ?? fallback) as T
}

async function readKey(svc: SupabaseClient): Promise<string | null> {
  const fromDb = await setting<string | null>(svc, 'openai_api_key', null)
  if (typeof fromDb === 'string' && fromDb.trim()) return fromDb.trim()
  const env = (process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY ?? '').trim()
  return env || null
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[]
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

export async function runAiAnalysis(svc: SupabaseClient, opts: AiRunOptions = {}): Promise<AiRunResult> {
  const started = Date.now()
  const log = opts.onProgress ?? (() => {})
  const errors: string[] = []
  const empty = {
    candidates: 0, screened: 0, shortlisted: 0, audited: 0, fetchOk: 0, affiliates: 0,
    ctaLinks: 0, ctaViaRoosterTracker: 0, roosterSites: 0, stagQueued: 0, contactPages: 0, costUsd: 0,
  }

  const enabled = await setting<boolean>(svc, 'ai_analysis_enabled', false)
  if (enabled !== true) {
    return { ok: true, skipped: 'ai_analysis_enabled is off', ...empty, ms: Date.now() - started }
  }
  const key = await readKey(svc)
  if (!key) {
    return { ok: true, skipped: 'no OpenAI key configured', ...empty, ms: Date.now() - started }
  }

  const triageModel = await setting<string>(svc, 'ai_triage_model', 'gpt-5-mini')
  const auditModel = await setting<string>(svc, 'ai_crawl_model', 'gpt-5-mini')
  const dailyCap = await setting<number>(svc, 'ai_crawl_daily_cap', 150)
  const budget = opts.budgetUsd ?? (await setting<number>(svc, 'ai_crawl_budget_usd', 5))
  const concurrency = opts.concurrency ?? 4
  const dry = opts.dryRun === true

  // Daily ceiling — count what today has already audited.
  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)
  const { count: auditedToday } = await svc
    .from('website_profiles')
    .select('id', { count: 'exact', head: true })
    .gte('ai_crawl_at', midnight.toISOString())
  const remainingToday = Math.max(0, dailyCap - (auditedToday ?? 0))
  if (remainingToday === 0) {
    return { ok: true, skipped: `daily cap reached (${dailyCap})`, ...empty, ms: Date.now() - started }
  }

  // ---- candidates ----
  let jobIds = opts.jobIds
  if (!jobIds) {
    let q = svc
      .from('scrape_queue')
      .select('id')
      .eq('status', 'completed')
      .gte('completed_at', new Date(Date.now() - (opts.days ?? 14) * 86_400_000).toISOString())
      .order('completed_at', { ascending: false })
      .limit(60)
    if (opts.countryCode) q = q.eq('country_code', opts.countryCode)
    const { data } = await q
    jobIds = ((data ?? []) as Array<{ id: string }>).map(r => r.id)
  }
  if (jobIds.length === 0) return { ok: true, skipped: 'no completed jobs in window', ...empty, ms: Date.now() - started }

  // ---- stage 0: is each result relevant to the keyword that found it? ----
  // Runs first and gates everything after it: a YouTube video or a Wikipedia
  // article that ranked for a casino keyword is never opened or charged for.
  let relevance: RelevanceRunResult | undefined
  if (!dry) {
    relevance = await runRelevanceForJobs(svc, key, triageModel, jobIds, { limit: 300 })
    if (relevance.checked > 0) {
      log(`relevance: ${relevance.checked} judged, ${relevance.rejected} rejected as off-keyword`)
    }
  }

  const { data: candRows, error: candErr } = await svc.rpc('ai_candidates_for_job', { p_job_ids: jobIds })
  if (candErr) return { ok: false, ...empty, ms: Date.now() - started, errors: [candErr.message] }
  const candidates = (candRows ?? []) as Candidate[]
  log(`candidates after trim: ${candidates.length}`)
  if (candidates.length === 0) return { ok: true, ...empty, ms: Date.now() - started }

  // Keywords each site ranked for — the only signal triage gets.
  const kwByProfile = new Map<number, string[]>()
  const ids = candidates.map(c => c.profile_id)
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await svc
      .from('website_appearances')
      .select('profile_id, keyword')
      .in('profile_id', ids.slice(i, i + 500))
      .order('seen_at', { ascending: false })
      .limit(3000)
    for (const r of (data ?? []) as Array<{ profile_id: number; keyword: string | null }>) {
      if (!r.keyword) continue
      const list = kwByProfile.get(r.profile_id) ?? []
      if (!list.includes(r.keyword) && list.length < 6) list.push(r.keyword)
      kwByProfile.set(r.profile_id, list)
    }
  }

  let cost = 0

  // ---- stage 1: triage ----
  const needTriage = candidates.filter(c => c.ai_screened_at === null).slice(0, opts.triageLimit ?? 50)
  let shortlisted = 0
  if (needTriage.length > 0) {
    const results = await pool(needTriage, concurrency, async c => ({
      c,
      v: await triage(key, triageModel, {
        domain: c.normalized_domain,
        countryCode: c.country_code,
        keywords: kwByProfile.get(c.profile_id) ?? [],
      }),
    }))
    const now = new Date().toISOString()
    for (const { c, v } of results) {
      cost += v.cost
      if (v.worth) shortlisted++
      if (dry) continue
      const { error } = await svc.from('website_profiles').update({
        ai_screened_at: now,
        ai_worth_checking: v.worth,
        ai_screen_reason: v.reason.slice(0, 500),
        ai_screen_model: triageModel,
      }).eq('id', c.profile_id)
      if (error) errors.push(`triage save ${c.normalized_domain}: ${error.message}`)
    }
    log(`triage: ${needTriage.length} screened, ${shortlisted} worth checking`)
  }

  // ---- stage 2: audit the shortlist ----
  const { data: shortRows } = await svc
    .from('website_profiles')
    .select('id, ai_crawl_at')
    .in('id', ids)
    .eq('ai_worth_checking', true)
  const auditable = new Set(
    ((shortRows ?? []) as Array<{ id: number; ai_crawl_at: string | null }>)
      .filter(r => r.ai_crawl_at === null)
      .map(r => r.id),
  )
  const toAudit = candidates
    .filter(c => auditable.has(c.profile_id))
    .slice(0, Math.min(opts.auditLimit ?? 25, remainingToday))

  if (toAudit.length === 0) {
    return {
      ok: true, ...(relevance ? { relevance } : {}), candidates: candidates.length, screened: needTriage.length, shortlisted,
      audited: 0, fetchOk: 0, affiliates: 0, ctaLinks: 0, ctaViaRoosterTracker: 0, roosterSites: 0,
      stagQueued: 0, contactPages: 0, costUsd: Number(cost.toFixed(5)), ms: Date.now() - started,
      ...(errors.length ? { errors } : {}),
    }
  }

  const { data: brandRows } = await svc.rpc('list_rooster_brand_domains')
  const brands = (brandRows ?? []) as Brand[]
  const instructions = auditInstructions(brands)
  const roosterNames = new Set(brands.map(b => (b.brand_name || b.domain).toLowerCase()))

  let fetchOk = 0
  let affiliates = 0
  let ctaLinks = 0
  let ctaTracker = 0
  let roosterSites = 0
  let contactPages = 0
  const stagLeads: Array<{ lead_id: number; country_code: string; url: string }> = []

  for (const c of toAudit) {
    if (cost >= budget) { log(`budget ${budget} reached, stopping`); break }

    const page = await fetchPage(c.url)
    const nowIso = new Date().toISOString()

    if (page.status !== 'ok' || page.text.length < 200) {
      if (!dry) {
        await svc.from('website_profiles').update({
          ai_crawl_at: nowIso,
          ai_crawl_model: auditModel,
          ai_crawl_status: page.status === 'blocked' ? 'blocked' : 'error',
          ai_affiliate_reason: `page fetch ${page.status}`,
        }).eq('id', c.profile_id)
      }
      log(`${c.normalized_domain}: fetch ${page.status}`)
      continue
    }
    fetchOk++

    // The landing page is often a category page, so also read the contact /
    // imprint page when the site links to one. This is what was missing when
    // the first test found 0 contact pages across 37 sites.
    const pages = [{ url: page.finalUrl, text: page.text }]
    const contactUrl = contactPageCandidate(page)
    let allLinks: PageLink[] = page.links
    if (contactUrl && contactUrl !== page.finalUrl) {
      const cp = await fetchPage(contactUrl, 15_000)
      if (cp.status === 'ok' && cp.text.length > 100) {
        pages.push({ url: cp.finalUrl, text: cp.text.slice(0, 6_000) })
        allLinks = [...page.links, ...cp.links]
        contactPages++
      }
    }

    const { verdict, cost: auditCost, error } = await audit(key, auditModel, instructions, pages, allLinks)
    cost += auditCost

    // ---- stage 3: CTA links, extracted and resolved in code ----
    // A candidate only counts once we know where it lands: anything that
    // resolves back to the site itself (an internal category page) or to a
    // payment / games-supplier host is not a brand CTA.
    const selfHost = hostOf(page.finalUrl)
    const cands = ctaCandidates(page)
    const walked = await pool(cands, 4, async l => ({ l, u: await unmask(l.href, page.finalUrl) }))
    const resolved = walked.filter(({ u }) => isOutboundCta(u, selfHost))
    ctaLinks += resolved.length

    const modelBrands = verdict?.brands ?? []
    if (!dry && resolved.length > 0) {
      for (const { l, u } of resolved) {
        if (u.tracker) ctaTracker++
        const hay = brandSlug(`${l.href} ${u.resolved ?? ''}`)
        const brand =
          modelBrands.find(n => n.length >= 4 && hay.includes(brandSlug(n))) ??
          brandFromLabel(l.label)
        const { error: ctaErr } = await svc.from('website_cta_links').upsert({
          profile_id: c.profile_id,
          brand_name: brand,
          cta_url: l.href,
          resolved_url: u.resolved,
          resolved_host: u.host,
          redirect_hops: u.hops,
          is_rooster_tracker: Boolean(u.tracker),
          tracker_host: u.tracker,
          is_rooster_brand: brand ? roosterNames.has(brand.toLowerCase()) : false,
          unmask_status: u.status,
          last_seen_at: nowIso,
        }, { onConflict: 'profile_id,cta_url' })
        if (ctaErr) errors.push(`cta ${c.normalized_domain}: ${ctaErr.message}`)
      }
    } else if (dry) {
      for (const { u } of resolved) if (u.tracker) ctaTracker++
    }

    const isAffiliate = verdict?.is_affiliate === true
    if (isAffiliate) affiliates++
    const foundRooster = (verdict?.rooster_brands_found.length ?? 0) > 0
    if (foundRooster) roosterSites++

    const newBrands = modelBrands.filter(n => !roosterNames.has(n.toLowerCase()))
    // Hand off to the VM's browser S-tag stage only when there is something
    // to click and it really is an affiliate.
    const handOff = isAffiliate && resolved.length > 0
    if (handOff && c.country_code && c.url.startsWith('http')) {
      stagLeads.push({ lead_id: c.lead_id, country_code: c.country_code, url: c.url })
    }

    if (!dry) {
      const { error: upErr } = await svc.from('website_profiles').update({
        ai_crawl_at: nowIso,
        ai_crawl_model: auditModel,
        ai_crawl_status: verdict ? 'ok' : 'error',
        ai_is_affiliate: verdict?.is_affiliate ?? null,
        ai_affiliate_reason: (verdict?.affiliate_reasoning ?? error ?? '').slice(0, 1000),
        ai_brands: modelBrands,
        ai_brand_count: modelBrands.length,
        ai_cta_count: resolved.length,
        ai_rooster_brands: verdict?.rooster_brands_found ?? [],
        ai_new_brands: newBrands,
        ai_emails: verdict?.emails ?? [],
        ai_phones: verdict?.phones ?? [],
        ai_contact_page_url: verdict?.contact_page_url ?? contactUrl,
        ai_pages_opened: pages.map(p => p.url),
        ai_cost_usd: Number(auditCost.toFixed(5)),
        manual_stag_status: handOff ? 'pending' : null,
      }).eq('id', c.profile_id)
      if (upErr) errors.push(`audit save ${c.normalized_domain}: ${upErr.message}`)
    }

    log(
      `${c.normalized_domain}: aff=${verdict?.is_affiliate ?? '?'} brands=${modelBrands.length} cta=${resolved.length}` +
      (foundRooster ? ` rooster=${verdict?.rooster_brands_found.join(',')}` : ''),
    )
  }

  // ---- stage 4: queue the browser S-tag pass ----
  let stagQueued = 0
  if (!dry && stagLeads.length > 0) {
    const leadIds = stagLeads.map(s => s.lead_id)
    const { data: already } = await svc
      .from('enrichment_fetch_queue')
      .select('lead_id')
      .in('lead_id', leadIds)
      .in('status', ['pending', 'running', 'paused'])
    const busy = new Set(((already ?? []) as Array<{ lead_id: number }>).map(r => r.lead_id))
    const rows = stagLeads
      .filter(s => !busy.has(s.lead_id))
      .map(s => ({
        lead_id: s.lead_id,
        country_code: s.country_code,
        url: s.url,
        want_html: true,
        want_screenshot: false,
        process_stages: ['stag'],
      }))
    if (rows.length > 0) {
      const { error } = await svc.from('enrichment_fetch_queue').insert(rows)
      if (error) errors.push(`stag enqueue: ${error.message}`)
      else stagQueued = rows.length
    }
  }

  return {
    ok: true,
    ...(relevance ? { relevance } : {}),
    candidates: candidates.length,
    screened: needTriage.length,
    shortlisted,
    audited: toAudit.length,
    fetchOk,
    affiliates,
    ctaLinks,
    ctaViaRoosterTracker: ctaTracker,
    roosterSites,
    stagQueued,
    contactPages,
    costUsd: Number(cost.toFixed(5)),
    ms: Date.now() - started,
    ...(errors.length ? { errors: errors.slice(0, 20) } : {}),
  }
}
