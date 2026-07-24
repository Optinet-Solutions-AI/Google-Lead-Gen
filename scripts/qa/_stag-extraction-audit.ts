/**
 * [LGP-086] Baseline S-tag extraction efficacy audit.
 *
 * Prerequisite for every other extraction-optimization task. Measures
 * the current-state success rate across every dimension so future
 * interventions have a real "before/after" comparison to point at.
 *
 * Signal we care about:
 *   - Denominator: leads flagged is_affiliate=true (we tried to
 *     extract from these)
 *   - Numerator: leads with has_s_tags=true (we succeeded)
 *
 * Dimensions we break down by:
 *   - Country code
 *   - Search engine (join through scrape_queue)
 *   - Root domain
 *   - Extraction method (s_tags_table.extracted_via)
 *
 * Usage:  npx tsx scripts/qa/_stag-extraction-audit.ts [DAYS]
 *         DAYS defaults to 30. Pass 7 for a shorter-recency check.
 *
 * The output at the top of the file (baseline block) should be
 * updated whenever an intervention ships so the delta is trackable.
 *
 * ================================================================
 * BASELINE (2026-07-24, 30d window — before any Phase-2 interventions):
 *   Overall extraction rate:  15.9% (262 of 1,648 attempts)
 *   Best country:             AE   29.6%
 *   Worst country:            AT    3.3%
 *   Winning params:           btag 24.4% · stag 12.6% · cxd 7.6% · mid 4.6% · affid 3.8%
 *                             (leaves ~47% of successes coming via OTHER paths — extracted_via
 *                              is only populated on ~53% of s_tag rows, data-quality gap.)
 *   Zero-success mass domains (100% miss): gameshub, pokerfirma, betvictor,
 *                             betway, ligaportal.at, wette.de, sportsline,
 *                             casino.netbet.com, freep, bestnewzealandcasinos,
 *                             casinos.at, royalpanda, casino.netbet.ie
 *   100% success mass domains: betiton.com (15/15), sportscasting.com (15/15),
 *                             casinofreak.com (10/10) — sanity check on the
 *                             extractor when it works.
 * ================================================================
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
const PAGE_SIZE = 1000

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return `${((n / d) * 100).toFixed(1)}%`
}
function rootDomain(url: string | null): string {
  if (!url) return '(no url)'
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return '(bad url)'
  }
}

async function fetchAllLeads() {
  const out: Array<{
    id: number
    url: string | null
    country_code: string | null
    is_affiliate: boolean | null
    has_s_tags: boolean | null
    s_tag_id: number | null
    s_tags_checked_at: string | null
    scrape_job_id: string | null
  }> = []
  let from = 0
  while (true) {
    const { data, error } = await s
      .from('google_lead_gen_table')
      .select(
        'id, url, country_code, is_affiliate, has_s_tags, s_tag_id, s_tags_checked_at, scrape_job_id',
      )
      .eq('is_affiliate', true)
      .gte('s_tags_checked_at', SINCE)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = (data ?? []) as typeof out
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
    if (from > 40_000) break
  }
  return out
}

;(async () => {
  console.log(`=== S-tag extraction efficacy audit ===`)
  console.log(`Window: last ${DAYS} days (since ${SINCE})\n`)

  const leads = await fetchAllLeads()
  const total = leads.length
  const withTag = leads.filter(l => l.has_s_tags === true).length
  console.log(`is_affiliate=true leads with an extraction attempt: ${total.toLocaleString()}`)
  console.log(`  with s_tag extracted:  ${withTag.toLocaleString()}  (${pct(withTag, total)})`)
  console.log(`  no s_tag:              ${(total - withTag).toLocaleString()}  (${pct(total - withTag, total)})\n`)

  // By country
  const byCountry = new Map<string, { total: number; success: number }>()
  for (const l of leads) {
    const cc = l.country_code ?? '(none)'
    const bucket = byCountry.get(cc) ?? { total: 0, success: 0 }
    bucket.total++
    if (l.has_s_tags) bucket.success++
    byCountry.set(cc, bucket)
  }
  console.log('=== By country (min 20 attempts) ===')
  console.log('country  attempts     ok    success%')
  const sortedByCountry = Array.from(byCountry.entries())
    .filter(([, b]) => b.total >= 20)
    .sort(([, a], [, b]) => b.total - a.total)
  for (const [cc, b] of sortedByCountry) {
    console.log(
      `  ${cc.padEnd(6)} ${String(b.total).padStart(8)}  ${String(b.success).padStart(6)}  ${pct(b.success, b.total).padStart(7)}`,
    )
  }

  // By root domain (top 20 in denominator)
  console.log('\n=== By root domain (top 20 by attempts) ===')
  const byDomain = new Map<string, { total: number; success: number }>()
  for (const l of leads) {
    const d = rootDomain(l.url)
    const bucket = byDomain.get(d) ?? { total: 0, success: 0 }
    bucket.total++
    if (l.has_s_tags) bucket.success++
    byDomain.set(d, bucket)
  }
  const topDomains = Array.from(byDomain.entries())
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 20)
  console.log('domain'.padEnd(42) + 'attempts     ok    success%')
  for (const [d, b] of topDomains) {
    console.log(
      `  ${d.padEnd(40)} ${String(b.total).padStart(8)}  ${String(b.success).padStart(6)}  ${pct(b.success, b.total).padStart(7)}`,
    )
  }

  // By search engine — join through scrape_queue
  const jobIds = Array.from(new Set(leads.map(l => l.scrape_job_id).filter(Boolean))) as string[]
  const engineByJob = new Map<string, string>()
  for (let i = 0; i < jobIds.length; i += 200) {
    const chunk = jobIds.slice(i, i + 200)
    const { data: jobs } = await s
      .from('scrape_queue')
      .select('id, search_engine')
      .in('id', chunk)
    for (const j of (jobs ?? []) as Array<{ id: string; search_engine: string | null }>) {
      engineByJob.set(j.id, j.search_engine ?? '(none)')
    }
  }
  console.log('\n=== By search engine ===')
  const byEngine = new Map<string, { total: number; success: number }>()
  for (const l of leads) {
    const e = l.scrape_job_id ? engineByJob.get(l.scrape_job_id) ?? '(none)' : '(none)'
    const bucket = byEngine.get(e) ?? { total: 0, success: 0 }
    bucket.total++
    if (l.has_s_tags) bucket.success++
    byEngine.set(e, bucket)
  }
  console.log('engine'.padEnd(14) + 'attempts     ok    success%')
  for (const [e, b] of Array.from(byEngine.entries()).sort(([, a], [, bb]) => bb.total - a.total)) {
    console.log(
      `  ${e.padEnd(12)} ${String(b.total).padStart(8)}  ${String(b.success).padStart(6)}  ${pct(b.success, b.total).padStart(7)}`,
    )
  }

  // Success side: distribution of extracted_via method
  const s_tag_ids = leads.filter(l => l.s_tag_id).map(l => l.s_tag_id!) as number[]
  const extractedVia = new Map<string, number>()
  const sourceParamCounts = new Map<string, number>()
  for (let i = 0; i < s_tag_ids.length; i += 200) {
    const chunk = s_tag_ids.slice(i, i + 200)
    const { data: tags } = await s
      .from('s_tags_table')
      .select('id, extracted_via, source_param')
      .in('id', chunk)
    for (const t of (tags ?? []) as Array<{
      extracted_via: string | null
      source_param: string | null
    }>) {
      const via = t.extracted_via ?? '(unknown)'
      extractedVia.set(via, (extractedVia.get(via) ?? 0) + 1)
      const sp = t.source_param ?? '(unknown)'
      sourceParamCounts.set(sp, (sourceParamCounts.get(sp) ?? 0) + 1)
    }
  }
  console.log('\n=== Successful extractions: HOW ===')
  console.log('extracted_via'.padEnd(30) + 'count      share')
  for (const [via, count] of Array.from(extractedVia.entries()).sort(([, a], [, b]) => b - a)) {
    console.log(
      `  ${via.padEnd(28)} ${String(count).padStart(6)}  ${pct(count, withTag).padStart(7)}`,
    )
  }
  console.log('\n=== Successful extractions: WHICH PARAM WON ===')
  console.log('source_param'.padEnd(20) + 'count      share')
  for (const [sp, count] of Array.from(sourceParamCounts.entries()).sort(([, a], [, b]) => b - a).slice(0, 20)) {
    console.log(
      `  ${sp.padEnd(18)} ${String(count).padStart(6)}  ${pct(count, withTag).padStart(7)}`,
    )
  }

  // Top failure domains (high attempts, low success)
  console.log('\n=== Worst-performing domains (>= 30 attempts, sorted by failure %) ===')
  const failureDomains = Array.from(byDomain.entries())
    .filter(([, b]) => b.total >= 30)
    .map(([d, b]) => ({ d, total: b.total, success: b.success, failRate: 1 - b.success / b.total }))
    .sort((a, b) => b.failRate - a.failRate)
    .slice(0, 20)
  console.log('domain'.padEnd(42) + 'attempts     ok    fail%')
  for (const r of failureDomains) {
    console.log(
      `  ${r.d.padEnd(40)} ${String(r.total).padStart(8)}  ${String(r.success).padStart(6)}  ${pct(r.total - r.success, r.total).padStart(6)}`,
    )
  }

  // Summary line for the "did we improve?" grep
  console.log(
    `\n[BASELINE ${new Date().toISOString().slice(0, 10)}] total=${total} extracted=${withTag} rate=${pct(withTag, total)}`,
  )
})().catch(e => { console.error(e); process.exit(1) })
