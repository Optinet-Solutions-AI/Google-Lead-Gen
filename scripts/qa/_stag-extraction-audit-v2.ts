/**
 * [LGP-096] Baseline S-tag audit v2: joins google_lead_gen_table
 * against fetched_html_cache to categorize failures by root cause.
 *
 * ================================================================
 * BASELINE v2 (2026-07-24, 30d window):
 *   Overall extraction rate: 15.9% (262 of 1,648) — same as v1.
 *
 *   Failure breakdown (v1 lumped all 1,386 misses together):
 *     NO_CACHE_ROW       718  43.6%  cache row missing (cleanup
 *                                    of old rows + never-fetched
 *                                    mix)
 *     FETCH_EMPTY        436  26.5%  html < 500 bytes — SPA that
 *                                    needs JS render
 *     EXTRACTION_FAILED  222  13.5%  html fetched OK, extractor
 *                                    missed the tag
 *     FETCH_ERROR          7   0.4%  Cloudflare / nav failed
 *     FETCH_TINY           3   0.2%  consent-gate / placeholder
 *
 *   TOP FETCH_EMPTY DOMAINS (need Playwright): gameshub, cardplayer,
 *     casino.netbet.ie, lottoland.ie, june.o2online.ie, mafia-casino,
 *     paris-sportifs.lefigaro.fr, eurosport.fr, spletne-igralnice.si.
 *
 *   TOP EXTRACTION_FAILED DOMAINS (need networks.ts + T2 cookies):
 *     qmra.eu (5), admiralbet.de (4), leovegas.com (4), pokerfirma
 *     (2), wette.de (2), znaki.fm (2), casibella.com (2), ung.no (2).
 *
 *   REVISED CEILING: JS render alone unblocks 436 leads (max +26.5pp).
 *   Widening the extractor unblocks 222 (max +13.5pp). Both together
 *   theoretically get us to ~56% — matches the memo's 40% target
 *   with buffer.
 * ================================================================
 */

/**
 * Follow-up (categorization vs raw fetch state):
 *
 * Before this we only knew "has_s_tags true/false". Now we split
 * the false bucket by:
 *   - FETCH_ERROR: fetched_html_cache.fetch_error is not null (nav
 *     failed / timeout / block)
 *   - FETCH_EMPTY: no fetch_error but html length is < 500 (SPA that
 *     needs JS to render)
 *   - FETCH_TINY: 500 to 5,000 bytes (probably a chrome error page,
 *     consent-gate page, or SEO placeholder)
 *   - EXTRACTION_FAILED: fetched OK, HTML populated, but the extractor
 *     didn't find a tracking link
 *   - NO_CACHE_ROW: no entry in fetched_html_cache at all — the
 *     enrichment job never ran or fell through a code path that
 *     bypasses the cache write
 *
 * This gives us a real "which intervention would fix this row?"
 * grouping instead of a black-box success rate.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const DAYS = Number.parseInt(process.argv[2] ?? '30', 10) || 30
const SINCE = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()

function rootDomain(url: string | null): string {
  if (!url) return '(no url)'
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return '(bad url)'
  }
}
function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`
}

type Bucket = 'success' | 'no_cache_row' | 'fetch_error' | 'fetch_empty' | 'fetch_tiny' | 'extraction_failed'

async function fetchLeads() {
  const out: Array<{
    id: number
    url: string | null
    country_code: string | null
    is_affiliate: boolean | null
    has_s_tags: boolean | null
  }> = []
  let from = 0
  while (true) {
    const { data, error } = await s
      .from('google_lead_gen_table')
      .select('id, url, country_code, is_affiliate, has_s_tags')
      .eq('is_affiliate', true)
      .gte('s_tags_checked_at', SINCE)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw error
    const rows = (data ?? []) as typeof out
    out.push(...rows)
    if (rows.length < 1000) break
    from += 1000
    if (from > 40_000) break
  }
  return out
}

;(async () => {
  console.log(`=== S-tag extraction audit v2 (with fetch diagnosis) ===`)
  console.log(`Window: last ${DAYS} days\n`)

  const leads = await fetchLeads()
  console.log(`is_affiliate leads with s_tags_checked_at in window: ${leads.length.toLocaleString()}`)

  // Batch-fetch fetched_html_cache rows by lead_id + url. The cache is
  // keyed by (lead_id, url) so we do this per-lead.
  const leadIds = leads.map(l => l.id)
  const cacheByLead = new Map<number, { fetch_error: string | null; html_length: number }>()
  const BATCH = 200
  for (let i = 0; i < leadIds.length; i += BATCH) {
    const chunk = leadIds.slice(i, i + BATCH)
    // Note: we only care whether it fetched OK, so we only need the
    // fetch_error + a small html sample to measure length. Pull
    // fetch_error and a length-of trick via octet_length is not
    // possible from the REST layer, so just fetch a substring.
    const { data } = await s
      .from('fetched_html_cache')
      .select('lead_id, fetch_error, html')
      .in('lead_id', chunk)
    for (const r of (data ?? []) as Array<{ lead_id: number; fetch_error: string | null; html: string | null }>) {
      // Multiple cache rows per lead possible (per-URL) — keep whichever
      // has an html body if we see multiples, else the errored one.
      const prev = cacheByLead.get(r.lead_id)
      const len = r.html?.length ?? 0
      if (!prev) cacheByLead.set(r.lead_id, { fetch_error: r.fetch_error, html_length: len })
      else if (len > prev.html_length) cacheByLead.set(r.lead_id, { fetch_error: r.fetch_error, html_length: len })
    }
    process.stdout.write(`\r  cache lookups: ${Math.min(i + BATCH, leadIds.length)}/${leadIds.length}`)
  }
  process.stdout.write('\n')

  // Categorize
  function categorize(lead: typeof leads[number]): Bucket {
    if (lead.has_s_tags) return 'success'
    const cache = cacheByLead.get(lead.id)
    if (!cache) return 'no_cache_row'
    if (cache.fetch_error) return 'fetch_error'
    if (cache.html_length < 500) return 'fetch_empty'
    if (cache.html_length < 5000) return 'fetch_tiny'
    return 'extraction_failed'
  }

  const counts: Record<Bucket, number> = {
    success: 0, no_cache_row: 0, fetch_error: 0, fetch_empty: 0, fetch_tiny: 0, extraction_failed: 0,
  }
  const byBucketDomain: Record<Bucket, Map<string, number>> = {
    success: new Map(), no_cache_row: new Map(),
    fetch_error: new Map(), fetch_empty: new Map(),
    fetch_tiny: new Map(), extraction_failed: new Map(),
  }
  for (const lead of leads) {
    const b = categorize(lead)
    counts[b]++
    const d = rootDomain(lead.url)
    const m = byBucketDomain[b]
    m.set(d, (m.get(d) ?? 0) + 1)
  }

  const total = leads.length
  console.log(`\n=== Overall categorization ===`)
  const labels: Record<Bucket, string> = {
    success: 'SUCCESS (has_s_tags)',
    no_cache_row: 'NO_CACHE_ROW (never wrote to fetched_html_cache)',
    fetch_error: 'FETCH_ERROR (navigation failed / timeout / block)',
    fetch_empty: 'FETCH_EMPTY (html < 500 bytes — SPA needs JS render)',
    fetch_tiny: 'FETCH_TINY (html < 5KB — consent gate / placeholder)',
    extraction_failed: 'EXTRACTION_FAILED (html fetched OK, extractor missed tag)',
  }
  for (const b of ['success', 'no_cache_row', 'fetch_error', 'fetch_empty', 'fetch_tiny', 'extraction_failed'] as Bucket[]) {
    console.log(`  ${counts[b].toString().padStart(5)}  (${pct(counts[b], total).padStart(6)})  ${labels[b]}`)
  }

  console.log('\n=== Which intervention would fix each bucket? ===')
  console.log('  NO_CACHE_ROW      → fix enrichment queue coverage / re-run stag extraction')
  console.log('  FETCH_ERROR       → Cloudflare handling + retry-with-different-UA')
  console.log('  FETCH_EMPTY       → JavaScript rendering (Playwright/Chromium, headed)')
  console.log('  FETCH_TINY        → cookie-consent auto-click + age-gate auto-click')
  console.log('  EXTRACTION_FAILED → widen networks.ts catalog + T2 cookies + T3 DOM parse')

  console.log('\n=== Top 10 domains per bucket ===')
  for (const b of ['fetch_error', 'fetch_empty', 'fetch_tiny', 'extraction_failed'] as Bucket[]) {
    const rows = Array.from(byBucketDomain[b].entries())
      .sort(([, a], [, bb]) => bb - a)
      .slice(0, 10)
    if (rows.length === 0) { console.log(`\n${labels[b]}: (none)`); continue }
    console.log(`\n${labels[b]}:`)
    for (const [d, n] of rows) console.log(`  ${String(n).padStart(4)}  ${d}`)
  }

  // The summary line for grep-comparison
  console.log(
    `\n[BASELINE_V2 ${new Date().toISOString().slice(0, 10)}] total=${total} success=${counts.success} rate=${pct(counts.success, total)} fetch_empty=${counts.fetch_empty} fetch_error=${counts.fetch_error} extraction_failed=${counts.extraction_failed}`,
  )
})().catch(e => { console.error(e); process.exit(1) })
