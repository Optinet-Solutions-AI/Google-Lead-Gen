/**
 * Re-run failed scrape batches GRADUALLY — release them in staggered waves
 * via scheduled_at so captchas arrive at noVNC at a manageable rate and the
 * VMs never get slammed (blackscreen risk). Worker concurrency already caps
 * simultaneous scrapes; this additionally caps how fast NEW work becomes
 * claimable.
 *
 * Guards (same as the plain requeue): dedupe the failed set by
 * (keyword,country,engine,view_mode), skip anything already in-flight, and
 * skip keywords already completed in the window (no duplicates).
 *
 *   npx tsx scripts/qa/_rerun-failed-gradual.ts                          # dry-run: show release schedule
 *   npx tsx scripts/qa/_rerun-failed-gradual.ts --apply                  # queue with staggered scheduled_at
 *   npx tsx scripts/qa/_rerun-failed-gradual.ts --apply --wave=6 --every=20 --days=8
 *
 * --wave  N   batches released per wave      (default 6)
 * --every M   minutes between waves          (default 20)
 * --days  D   look back D days for failures  (default 8)
 */
import { config } from 'dotenv'; config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const APPLY = process.argv.includes('--apply')
const num = (flag: string, def: number) => {
  const a = process.argv.find(x => x.startsWith(`--${flag}=`))
  return a ? Math.max(1, parseInt(a.split('=')[1]!, 10) || def) : def
}
const WAVE = num('wave', 6)
const EVERY_MIN = num('every', 20)
const DAYS = num('days', 8)
const nowMs = Date.now()
const sinceIso = new Date(nowMs - DAYS * 86400_000).toISOString()

type Job = {
  id: string; keyword: string; country_code: string; pages: number; priority: number
  with_enrichment: boolean; language: string | null; search_engine: string | null
  view_mode: string | null; result_type_filter: string | null; status: string; created_at: string
  parent_scrape_job_id: string | null
  created_by_email: string | null; created_by_username: string | null
  created_by_display: string | null; created_by_is_shadow: boolean | null
}
const COLS = 'id,keyword,country_code,pages,priority,with_enrichment,language,search_engine,view_mode,result_type_filter,status,created_at,parent_scrape_job_id,created_by_email,created_by_username,created_by_display,created_by_is_shadow'
const key = (j: Pick<Job, 'keyword' | 'country_code' | 'search_engine' | 'view_mode'>) =>
  `${(j.keyword || '').trim().toLowerCase()}|${j.country_code}|${j.search_engine ?? 'google'}|${j.view_mode ?? 'both'}`

async function pageAll(status: string, since?: string): Promise<Job[]> {
  const out: Job[] = []; let from = 0
  for (;;) {
    let q = s.from('scrape_queue').select(COLS).eq('status', status).range(from, from + 999)
    if (since) q = q.gte('created_at', since)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    out.push(...(data as Job[])); if (data.length < 1000) break; from += 1000
  }
  return out
}

async function main() {
  console.log(`[gradual-rerun] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} wave=${WAVE}/${EVERY_MIN}min lookback=${DAYS}d`)
  const failed = (await pageAll('failed', sinceIso)).filter(j => j.parent_scrape_job_id === null)
  const inflight = new Set<string>()
  for (const st of ['pending', 'running', 'captcha', 'needs_human']) for (const j of await pageAll(st)) inflight.add(key(j))
  const completed = new Set<string>((await pageAll('completed', sinceIso)).map(key))

  const byKey = new Map<string, Job>()
  for (const j of failed.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) if (!byKey.has(key(j))) byKey.set(key(j), j)

  const queue: Job[] = []
  let skipIn = 0, skipComp = 0
  for (const [k, j] of byKey) {
    if (inflight.has(k)) { skipIn++; continue }
    if (completed.has(k)) { skipComp++; continue }
    queue.push(j)
  }

  console.log(`failed=${failed.length} unique=${byKey.size} skipInflight=${skipIn} skipCompleted=${skipComp} → toRun=${queue.length}`)
  if (queue.length === 0) { console.log('nothing to re-run.'); return }

  const waves = Math.ceil(queue.length / WAVE)
  const spanMin = (waves - 1) * EVERY_MIN
  console.log(`\nrelease plan: ${queue.length} batches in ${waves} waves of ${WAVE}, ${EVERY_MIN} min apart → spread over ~${spanMin} min (${(spanMin / 60).toFixed(1)}h)`)
  // preview first few waves
  for (let w = 0; w < Math.min(waves, 4); w++) {
    const at = new Date(nowMs + w * EVERY_MIN * 60_000)
    const items = queue.slice(w * WAVE, w * WAVE + WAVE).map(j => `${j.country_code}:${(j.keyword || '').slice(0, 18)}`)
    console.log(`  wave ${w + 1} @ ${at.toISOString().slice(11, 16)}Z: ${items.join(' · ')}`)
  }
  if (waves > 4) console.log(`  … + ${waves - 4} more waves`)

  if (!APPLY) { console.log('\n(dry-run — nothing queued. Add --apply to release.)'); return }

  let inserted = 0
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i]!
    const wave = Math.floor(i / WAVE)
    const scheduledAt = new Date(nowMs + wave * EVERY_MIN * 60_000).toISOString()
    const { error } = await s.from('scrape_queue').insert({
      keyword: j.keyword, country_code: j.country_code, pages: j.pages, priority: j.priority,
      with_enrichment: j.with_enrichment, language: j.language ?? 'en', search_engine: j.search_engine ?? 'google',
      view_mode: j.view_mode ?? 'both', result_type_filter: j.result_type_filter ?? null,
      scheduled_at: scheduledAt,
      created_by_email: j.created_by_email, created_by_username: j.created_by_username,
      created_by_display: j.created_by_display, created_by_is_shadow: j.created_by_is_shadow ?? false,
    })
    if (error) { console.error(`  ! ${j.keyword} [${j.country_code}]: ${error.message}`); continue }
    inserted++
  }
  const lastAt = new Date(nowMs + (waves - 1) * EVERY_MIN * 60_000)
  console.log(`\n✅ queued ${inserted} batches, staggered. Last wave releases ~${lastAt.toISOString().slice(11, 16)}Z.`)
}

main().catch(e => { console.error(e); process.exit(1) })
