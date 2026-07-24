/**
 * [LGP-087] + [LGP-093] URL-list generator for the cookie POC.
 *
 * Produces a plaintext file (one URL per line) that vm/stag_cookie_poc.py
 * consumes. Two sections:
 *
 *   1. VALIDATION: 5 leads we already know the affiliate ID for
 *      (they're on Monday with a matched s_tag). If cookie extraction
 *      produces the same value → strong signal it works. If not,
 *      we know the extractor still needs work.
 *
 *   2. DISCOVERY: 20 leads from currently-unmapped affiliate domains.
 *      These are the "cookies_only" candidates — if the cookie path
 *      picks up something here that the URL path missed, we've
 *      justified building the full cookie extractor.
 *
 * Usage:  npx tsx scripts/qa/_stag-poc-url-list.ts > vm/candidate_urls.txt
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
  console.log('# S-tag cookie POC candidate URLs')
  console.log(`# generated ${new Date().toISOString()}`)
  console.log('')

  // ---------------- VALIDATION set ----------------
  console.log('# === VALIDATION: leads with a known Monday-matched s_tag ===')
  const { data: knownRaw } = await s
    .from('s_tags_table')
    .select('s_tag, source_param, final_url, lead:google_lead_gen_table!inner(url, country_code, is_on_monday)')
    .not('s_tag', 'is', null)
    .eq('is_existing_on_monday', true)
    .not('final_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50)
  const known = (knownRaw ?? []) as Array<{
    s_tag: string
    source_param: string | null
    final_url: string | null
    lead: { url: string | null; country_code: string | null; is_on_monday: boolean | null } | null
  }>
  const seenValidation = new Set<string>()
  let validationCount = 0
  for (const r of known) {
    const url = r.final_url ?? r.lead?.url
    if (!url) continue
    let host = ''
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { continue }
    if (seenValidation.has(host)) continue // one per domain
    seenValidation.add(host)
    console.log(`# expected s_tag = ${r.s_tag}  (param=${r.source_param ?? '?'}, country=${r.lead?.country_code ?? '?'})`)
    console.log(url)
    validationCount++
    if (validationCount >= 5) break
  }
  console.log(`# (validation subtotal: ${validationCount})`)
  console.log('')

  // ---------------- DISCOVERY set ----------------
  console.log('# === DISCOVERY: leads on domains where we currently EXTRACT NOTHING ===')
  // Domains where is_affiliate=true but has_s_tags=false, with a URL
  // we can actually fetch. Sample from the 30d window.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: unmappedRaw } = await s
    .from('google_lead_gen_table')
    .select('url, country_code')
    .eq('is_affiliate', true)
    .eq('has_s_tags', false)
    .not('url', 'is', null)
    .gte('s_tags_checked_at', since)
    .order('id', { ascending: false })
    .limit(400)
  const unmapped = (unmappedRaw ?? []) as Array<{ url: string | null; country_code: string | null }>

  const seenDiscovery = new Set<string>()
  let discoveryCount = 0
  for (const r of unmapped) {
    if (!r.url) continue
    let host = ''
    try { host = new URL(r.url).hostname.toLowerCase().replace(/^www\./, '') } catch { continue }
    if (seenValidation.has(host) || seenDiscovery.has(host)) continue
    seenDiscovery.add(host)
    console.log(`# unmapped (country=${r.country_code ?? '?'}, domain=${host})`)
    console.log(r.url)
    discoveryCount++
    if (discoveryCount >= 20) break
  }
  console.log(`# (discovery subtotal: ${discoveryCount})`)
  console.log('')
  console.log(`# TOTAL: ${validationCount + discoveryCount} URLs`)
})().catch(e => { console.error(e); process.exit(1) })
