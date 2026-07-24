import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

;(async () => {
  // Schema check
  const { data: sample } = await s.from('fetched_html_cache').select('*').limit(1).maybeSingle()
  console.log('=== fetched_html_cache columns ===')
  if (sample) console.log(Object.keys(sample as Record<string, unknown>).sort().join('\n'))
  else console.log('(no rows in fetched_html_cache)')

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { count: total } = await s
    .from('fetched_html_cache')
    .select('lead_id', { count: 'exact', head: true })
    .gte('fetched_at', since)
  console.log(`\nfetched_html_cache rows in last 30d: ${total}`)

  // Distribution: fetch_error null vs populated + html length buckets
  const { data: rows } = await s
    .from('fetched_html_cache')
    .select('lead_id, url, fetch_error, html, fetched_at')
    .gte('fetched_at', since)
    .limit(5000)
  const arr = ((rows ?? []) as Array<{ lead_id: number; url: string | null; fetch_error: string | null; html: string | null }>)
  const buckets = { errored: 0, empty_html: 0, tiny: 0, small: 0, medium: 0, large: 0 }
  const errorPatterns = new Map<string, number>()
  for (const r of arr) {
    if (r.fetch_error) {
      buckets.errored++
      const bucket = r.fetch_error.slice(0, 80)
      errorPatterns.set(bucket, (errorPatterns.get(bucket) ?? 0) + 1)
      continue
    }
    const len = r.html?.length ?? 0
    if (len === 0) buckets.empty_html++
    else if (len < 1000) buckets.tiny++
    else if (len < 10_000) buckets.small++
    else if (len < 100_000) buckets.medium++
    else buckets.large++
  }
  console.log('\n=== Distribution (sample of up to 5,000 rows) ===')
  console.log(`  fetch_error populated:  ${buckets.errored}`)
  console.log(`  fetch_error null, html empty (0 bytes):  ${buckets.empty_html}`)
  console.log(`  fetch_error null, html tiny (<1KB):      ${buckets.tiny}`)
  console.log(`  fetch_error null, html small (1-10KB):   ${buckets.small}`)
  console.log(`  fetch_error null, html medium (10-100K): ${buckets.medium}`)
  console.log(`  fetch_error null, html large (>100K):    ${buckets.large}`)

  console.log('\n=== Top fetch_error patterns ===')
  for (const [msg, n] of [...errorPatterns.entries()].sort(([, a], [, b]) => b - a).slice(0, 15)) {
    console.log(`  ${String(n).padStart(5)}  ${msg}`)
  }

  // Now cross-correlate: for the failure domains from the audit, does html exist in cache?
  const failureHosts = [
    'gameshub.com', 'cardplayer.com', 'pokerfirma.com', 'hochgepokert.com',
    'casinobeats.com', 'betvictor.com', 'betway.com', 'ligaportal.at',
    'wette.de', 'sportsline.com', 'casino.netbet.com', 'freep.com',
    'bestnewzealandcasinos.com', 'casinos.at', 'royalpanda.com',
  ]
  console.log('\n=== fetched_html_cache stats per top failure domain ===')
  for (const host of failureHosts) {
    const { data: hostRows } = await s
      .from('fetched_html_cache')
      .select('lead_id, fetch_error, html')
      .ilike('url', `%${host}%`)
      .gte('fetched_at', since)
      .limit(50)
    const hArr = ((hostRows ?? []) as Array<{ fetch_error: string | null; html: string | null }>)
    const errCount = hArr.filter(r => r.fetch_error).length
    const emptyCount = hArr.filter(r => !r.fetch_error && (r.html?.length ?? 0) === 0).length
    const okCount = hArr.filter(r => !r.fetch_error && (r.html?.length ?? 0) > 0).length
    console.log(`  ${host.padEnd(30)}  n=${String(hArr.length).padStart(3)}  err=${errCount}  empty=${emptyCount}  ok=${okCount}`)
    // Show up to 2 sample errors
    const sampleErrs = hArr.filter(r => r.fetch_error).slice(0, 2)
    for (const e of sampleErrs) console.log(`      err: ${String(e.fetch_error).slice(0, 100)}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
