/**
 * Second-pass retry for scrape_queue rows that hit `captcha` status in
 * the 09:04-UTC retry window. Same clone-insert pattern as
 * bulkRerunScrapeJobs. Halts if the captcha pool has already dropped
 * below ~1/4 of the previous check (25% remaining = time to switch to
 * human review instead).
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const RETRY_WINDOW_START = '2026-07-20T09:04:00Z'
const PREVIOUS_STUCK_COUNT = 33
const HUMAN_HANDOFF_THRESHOLD = Math.ceil(PREVIOUS_STUCK_COUNT / 4) // 9

async function main() {
  const { data } = await s
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, pages, priority, with_enrichment, language, search_engine, view_mode, result_type_filter, created_by_email, created_by_username, created_by_display, created_by_is_shadow',
    )
    .eq('status', 'captcha')
    .gte('created_at', RETRY_WINDOW_START)
    .is('parent_scrape_job_id', null)
    .limit(500)

  type Row = {
    id: string
    keyword: string
    country_code: string
    pages: number
    priority: number
    with_enrichment: boolean
    language: string | null
    search_engine: string | null
    view_mode: string | null
    result_type_filter: string | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
  }
  const rows = (data ?? []) as Row[]

  console.log(`Found ${rows.length} captcha-stuck row(s) from retry window`)
  console.log(`Previous count: ${PREVIOUS_STUCK_COUNT}`)
  console.log(`Human handoff threshold: ≤ ${HUMAN_HANDOFF_THRESHOLD} (25% of previous)`)

  if (rows.length === 0) {
    console.log('\nNo captcha-stuck rows to retry. Done.')
    return
  }
  if (rows.length <= HUMAN_HANDOFF_THRESHOLD) {
    console.log(`\nOnly ${rows.length} left (at/under 25% threshold). Skipping auto-retry — hand these to a human reviewer via /scrape bulk actions.`)
    return
  }

  // Dedup guard: skip any (keyword, country, engine) that already has an
  // in-flight sibling. Prevents the retry-clone explosion that pass 3-5
  // caused before this fix.
  const dedupBefore = rows.length
  const uniqueKeywords = Array.from(new Set(rows.map(r => r.keyword)))
  const inFlight = new Set<string>()
  const BATCH_LOOKUP = 100
  for (let i = 0; i < uniqueKeywords.length; i += BATCH_LOOKUP) {
    const chunk = uniqueKeywords.slice(i, i + BATCH_LOOKUP)
    const { data } = await s
      .from('scrape_queue')
      .select('keyword, country_code, search_engine')
      .in('keyword', chunk)
      .in('status', ['pending', 'running', 'needs_human'])
      .is('parent_scrape_job_id', null)
    for (const inf of ((data ?? []) as Array<{ keyword: string; country_code: string; search_engine: string | null }>)) {
      inFlight.add(`${inf.keyword}|${inf.country_code}|${inf.search_engine ?? 'google'}`)
    }
  }
  const safeRows = rows.filter(r => !inFlight.has(`${r.keyword}|${r.country_code}|${r.search_engine ?? 'google'}`))
  const skippedCount = dedupBefore - safeRows.length
  if (skippedCount > 0) {
    console.log(`\nDedup guard skipped ${skippedCount} row(s) that already have an in-flight sibling in the queue.`)
  }
  if (safeRows.length === 0) {
    console.log('\nNothing left to retry after dedup. Everything captcha-stuck already has an in-flight retry pending — wait for those to finish.')
    return
  }
  const finalRows = safeRows

  const perUser = new Map<string, number>()
  const perCountry = new Map<string, number>()
  for (const r of finalRows) {
    const u = (r.created_by_email ?? 'unknown').toLowerCase()
    perUser.set(u, (perUser.get(u) ?? 0) + 1)
    perCountry.set(r.country_code, (perCountry.get(r.country_code) ?? 0) + 1)
  }
  console.log('\nBy user:')
  for (const [u, n] of Array.from(perUser.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${u.padEnd(30)} ${n}`)
  }
  console.log('\nBy country:')
  for (const [c, n] of Array.from(perCountry.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n}`)
  }

  const inserts = finalRows.map(r => ({
    keyword: r.keyword,
    country_code: r.country_code,
    pages: r.pages,
    priority: r.priority,
    with_enrichment: r.with_enrichment,
    language: r.language ?? 'en',
    search_engine: r.search_engine ?? 'google',
    view_mode: r.view_mode ?? 'both',
    result_type_filter: r.result_type_filter,
    created_by_email: r.created_by_email,
    created_by_username: r.created_by_username,
    created_by_display: r.created_by_display,
    created_by_is_shadow: r.created_by_is_shadow ?? false,
  }))

  console.log('\n>>> Executing second-pass retry inserts...')
  const { data: inserted, error } = await s
    .from('scrape_queue')
    .insert(inserts)
    .select('id')
  if (error) {
    console.error('  insert failed:', error.message)
    process.exit(1)
  }
  console.log(`  inserted ${inserted?.length ?? 0} row(s)`)

  await s.from('activity_log').insert({
    action: 'scrape.bulk_retry_pass2',
    entity_type: 'scrape_jobs_bulk',
    actor_email: 'system@cleanup',
    details: {
      script: 'scripts/qa/_retry-pass2.ts',
      retried: inserted?.length ?? 0,
      previous_stuck_count: PREVIOUS_STUCK_COUNT,
      human_handoff_threshold: HUMAN_HANDOFF_THRESHOLD,
    },
  })

  console.log('\nDone.')
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
