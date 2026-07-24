/**
 * Yesterday's (2026-07-23 UTC) failed scrape batches by user + error
 * pattern. Groups by exact error_message so we see how many distinct
 * failure modes we have and which users are worst-hit.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

;(async () => {
  // Yesterday UTC bounds
  const now = new Date()
  const yStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  const yEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const since = yStart.toISOString()
  const until = yEnd.toISOString()

  console.log(`Yesterday window (UTC): ${since} → ${until}`)

  const { data } = await s
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, search_engine, status, error_message, created_by_display, created_at, completed_at, claimed_by',
    )
    .in('status', ['failed', 'captcha'])
    .is('parent_scrape_job_id', null)
    .gte('created_at', since)
    .lt('created_at', until)
    .order('created_at', { ascending: false })
  const rows = (data ?? []) as Array<{
    id: string
    keyword: string | null
    country_code: string | null
    search_engine: string | null
    status: string
    error_message: string | null
    created_by_display: string | null
    created_at: string | null
    completed_at: string | null
    claimed_by: string | null
  }>

  console.log(`\n${rows.length} failed/captcha phase-1 rows from yesterday.\n`)

  // Per user
  const perUser = new Map<string, { failed: number; captcha: number }>()
  for (const r of rows) {
    const u = r.created_by_display ?? '(unknown)'
    const b = perUser.get(u) ?? { failed: 0, captcha: 0 }
    if (r.status === 'failed') b.failed++
    else b.captcha++
    perUser.set(u, b)
  }
  console.log('=== By user ===')
  console.log(`${'User'.padEnd(24)} ${'failed'.padStart(7)} ${'captcha'.padStart(8)}`)
  for (const [u, b] of [...perUser.entries()].sort(([, a], [, bb]) => bb.failed + bb.captcha - (a.failed + a.captcha))) {
    console.log(`${u.padEnd(24)} ${String(b.failed).padStart(7)} ${String(b.captcha).padStart(8)}`)
  }

  // Group by error_message — collapse the tail into "similar" buckets
  const byError = new Map<string, { count: number; sampleId: string; users: Set<string> }>()
  for (const r of rows) {
    const raw = (r.error_message ?? '(no message)').slice(0, 240)
    const bucket = byError.get(raw) ?? { count: 0, sampleId: r.id, users: new Set<string>() }
    bucket.count++
    bucket.users.add(r.created_by_display ?? '(unknown)')
    byError.set(raw, bucket)
  }
  const sorted = [...byError.entries()].sort(([, a], [, b]) => b.count - a.count)
  console.log('\n=== Top error_message patterns (verbatim, first 240 chars) ===')
  for (const [msg, info] of sorted.slice(0, 15)) {
    console.log(`\n[${info.count}x, users: ${[...info.users].sort().join(', ')}]`)
    console.log(`  sample id: ${info.sampleId}`)
    console.log(`  ${msg}`)
  }

  // For each user, list up to 5 specific rows so we can drill in
  console.log('\n=== Sample rows per user (up to 5 each) ===')
  const perUserRows = new Map<string, typeof rows>()
  for (const r of rows) {
    const u = r.created_by_display ?? '(unknown)'
    const arr = perUserRows.get(u) ?? ([] as typeof rows)
    arr.push(r)
    perUserRows.set(u, arr)
  }
  for (const [u, arr] of perUserRows) {
    console.log(`\n${u}:`)
    for (const r of arr.slice(0, 5)) {
      const emStr = r.error_message ? String(r.error_message).slice(0, 90) : '(none)'
      console.log(`  ${r.status.padEnd(8)}  ${r.country_code}/${r.search_engine ?? '?'.padEnd(8)}  ${String(r.keyword ?? '').slice(0, 42).padEnd(42)}  ${emStr}`)
    }
    if (arr.length > 5) console.log(`  ... +${arr.length - 5} more`)
  }
})().catch(e => { console.error(e); process.exit(1) })
