/**
 * Re-enqueue every is_affiliate lead that never went through S-tag
 * extraction (NO_CACHE_ROW bucket from the v2 audit) into
 * enrichment_fetch_queue. When the enrichment workers on the VMs
 * pick these up, they'll run through the newly-widened extraction
 * pipeline (T1 URL-param check with networks.ts + HTML DEEP).
 *
 * Only enqueues leads that:
 *  - is_affiliate = true
 *  - has_s_tags   = false
 *  - is_stag_overridden_at is null   (operator hasn't manually acked)
 *  - no in-flight enrichment_fetch_queue row for this lead
 *  - no fetched_html_cache row for this lead (i.e. NO_CACHE_ROW)
 *
 * DRY RUN by default. Pass --apply to actually enqueue.
 * --limit N caps the enqueue size (default 3000).
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { shouldSkipDomain } from '@/lib/affiliate-detection/scorer'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const APPLY = process.argv.includes('--apply')
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  if (i < 0) return 3000
  return Math.max(1, Number.parseInt(process.argv[i + 1] ?? '3000', 10) || 3000)
})()

;(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY (enqueues into enrichment_fetch_queue)' : 'DRY RUN'}`)
  console.log(`Limit: ${LIMIT}`)

  // Step 1: page through is_affiliate leads that don't have a tag yet.
  const wanted: Array<{
    id: number
    url: string
    domain: string | null
    country_code: string | null
  }> = []
  let from = 0
  while (wanted.length < LIMIT) {
    const { data } = await s
      .from('google_lead_gen_table')
      .select('id, url, domain, country_code')
      .eq('is_affiliate', true)
      .eq('has_s_tags', false)
      .is('is_stag_overridden_at', null)
      .not('url', 'is', null)
      .not('country_code', 'is', null)
      .order('id', { ascending: false })
      .range(from, from + 999)
    const arr = ((data ?? []) as typeof wanted)
    if (arr.length === 0) break
    wanted.push(...arr)
    if (arr.length < 1000) break
    from += 1000
    if (from > 50_000) break
  }
  console.log(`Candidate leads (before cache/queue filter): ${wanted.length}`)

  // Step 2: exclude leads that already have a cache row (they were
  // processed at some point — a re-run through the same pipeline
  // won't help without a code change). Batch-check.
  const withCache = new Set<number>()
  const ids = wanted.map(w => w.id)
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300)
    const { data } = await s
      .from('fetched_html_cache')
      .select('lead_id')
      .in('lead_id', chunk)
    for (const r of ((data ?? []) as Array<{ lead_id: number }>)) withCache.add(r.lead_id)
  }
  console.log(`  leads with existing cache row (excluded): ${withCache.size}`)

  // Step 3: exclude leads with an in-flight enrichment_fetch_queue row.
  const inFlight = new Set<number>()
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300)
    const { data } = await s
      .from('enrichment_fetch_queue')
      .select('lead_id, status, process_stages')
      .in('lead_id', chunk)
      .in('status', ['pending', 'running'])
    for (const r of ((data ?? []) as Array<{ lead_id: number; process_stages: string[] | null }>)) {
      const stages = r.process_stages ?? []
      if (stages.includes('stag')) inFlight.add(r.lead_id)
    }
  }
  console.log(`  leads with in-flight stag enrichment (excluded): ${inFlight.size}`)

  const enqueueable = wanted
    .filter(w => !withCache.has(w.id) && !inFlight.has(w.id))
    .filter(w => !shouldSkipDomain(w.domain))
    .map(w => ({
      lead_id: w.id,
      country_code: w.country_code!,
      url: w.url,
      want_html: true,
      want_screenshot: false,
      process_stages: ['stag'],
    }))
  console.log(`\nEnqueueable leads: ${enqueueable.length}`)

  // Domain distribution — quick eyeball of where they concentrate.
  const perCountry = new Map<string, number>()
  for (const e of enqueueable) perCountry.set(e.country_code, (perCountry.get(e.country_code) ?? 0) + 1)
  const sorted = [...perCountry.entries()].sort(([, a], [, b]) => b - a)
  console.log(`\nPer country:`)
  for (const [cc, n] of sorted.slice(0, 10)) console.log(`  ${cc.padEnd(4)} ${n}`)

  if (!APPLY) {
    console.log(`\n(Dry run — pass --apply to enqueue.)`)
    return
  }

  // Cap at LIMIT so a single --apply doesn't dump 10k rows into the
  // queue and overwhelm the enrichment workers.
  const toEnqueue = enqueueable.slice(0, LIMIT)
  const BATCH = 200
  let inserted = 0
  for (let i = 0; i < toEnqueue.length; i += BATCH) {
    const chunk = toEnqueue.slice(i, i + BATCH)
    const { error } = await s.from('enrichment_fetch_queue').insert(chunk)
    if (error) {
      console.log(`  insert failed at chunk ${i}: ${error.message}`)
      break
    }
    inserted += chunk.length
    process.stdout.write(`\r  enqueued: ${inserted}/${toEnqueue.length}`)
  }
  process.stdout.write('\n')
  console.log(`\nEnqueued ${inserted} leads into enrichment_fetch_queue.`)
  console.log(`Workers will process these over the next hour(s). Re-run the audit to see the lift.`)
})().catch(e => { console.error(e); process.exit(1) })
