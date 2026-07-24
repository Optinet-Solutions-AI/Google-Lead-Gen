/**
 * Bulk re-extraction pass over every fetched_html_cache row for leads
 * that don't yet have has_s_tags=true. Runs the new stack:
 *   1. T1 URL-param check against every param in networks.ts
 *      (previously only 5 params, now 35+)
 *   2. T1 HTML DEEP: __NEXT_DATA__ / data-attrs / inline JS
 *   3. T1 tracking-link fanout using the widened URL-param check
 *
 * For every non-null result, calls replace_and_verify_s_tags_for_lead
 * so the row is properly tracked as a success and flows through the
 * Monday-match / rooster-brand cross-check.
 *
 * DRY RUN by default — pass --apply to actually persist.
 *
 * Usage:
 *   npx tsx scripts/qa/_bulk-re-extract-cached-html.ts [--apply]
 *   npx tsx scripts/qa/_bulk-re-extract-cached-html.ts --apply --limit 200
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { findTrackingLinks, parseStagFromUrl, guessBrandFromUrl } from '@/lib/stag-extraction/extract'
import { extractFromHtml } from '@/lib/stag-extraction/html-deep-extract'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const APPLY = process.argv.includes('--apply')
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  if (i < 0) return 5000
  return Math.max(1, Number.parseInt(process.argv[i + 1] ?? '5000', 10) || 5000)
})()

;(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY (writes to DB)' : 'DRY RUN'}`)
  console.log(`Limit: ${LIMIT}`)

  // Step 1: enumerate lead_ids that (a) still need a tag and (b) have
  // a non-null html cache row. Cheap because we don't pull the html
  // column here. Paginate — REST caps at 1000/page.
  const candidateRows: Array<{ lead_id: number; url: string; fetch_error: string | null }> = []
  let from = 0
  while (candidateRows.length < LIMIT) {
    const { data: chunk } = await s
      .from('fetched_html_cache')
      .select('lead_id, url, fetch_error')
      .not('html', 'is', null)
      .order('fetched_at', { ascending: false })
      .range(from, from + 999)
    const arr = ((chunk ?? []) as Array<{ lead_id: number; url: string; fetch_error: string | null }>)
      .filter(r => !r.fetch_error)
    candidateRows.push(...arr)
    if (arr.length < 1000 - (arr.length !== chunk?.length ? (chunk?.length ?? 0) - arr.length : 0)) break
    from += 1000
    if (from > 30_000) break
  }
  console.log(`Cache rows enumerated: ${candidateRows.length}`)

  const leadIds = Array.from(new Set(candidateRows.map(r => r.lead_id)))
  const wantSet = new Set<number>()
  for (let i = 0; i < leadIds.length; i += 300) {
    const chunk = leadIds.slice(i, i + 300)
    const { data: leads } = await s
      .from('google_lead_gen_table')
      .select('id, has_s_tags, is_affiliate, is_stag_overridden_at')
      .in('id', chunk)
    for (const l of (leads ?? []) as Array<{
      id: number
      has_s_tags: boolean | null
      is_affiliate: boolean | null
      is_stag_overridden_at: string | null
    }>) {
      if (l.is_affiliate && !l.has_s_tags && !l.is_stag_overridden_at) wantSet.add(l.id)
    }
  }
  const workableCandidates = candidateRows.filter(r => wantSet.has(r.lead_id))
  console.log(`Leads still needing extraction: ${workableCandidates.length}`)

  // Step 2: pull the html for each candidate individually so the big
  // payload doesn't trip the REST layer's response cap.
  const workable: Array<{ lead_id: number; url: string; html: string }> = []
  for (const cand of workableCandidates) {
    const { data: full } = await s
      .from('fetched_html_cache')
      .select('html')
      .eq('lead_id', cand.lead_id)
      .eq('url', cand.url)
      .maybeSingle()
    const html = (full as { html: string | null } | null)?.html ?? ''
    if (html.length >= 500) workable.push({ lead_id: cand.lead_id, url: cand.url, html })
    if (workable.length % 100 === 0 && workable.length > 0) {
      process.stdout.write(`\r  hydrating html: ${workable.length}/${workableCandidates.length}`)
    }
  }
  process.stdout.write('\n')
  console.log(`Leads with non-empty HTML to re-extract: ${workable.length}`)

  let t1UrlParam = 0
  let t1NextData = 0
  let t1DataAttr = 0
  let t1InlineJs = 0
  let t1TrackingLink = 0
  let noHit = 0
  let persisted = 0

  for (const row of workable) {
    const html = row.html!
    let found: {
      s_tag: string
      source_param: string
      brand: string | null
      tracking_url: string | null
      final_url: string
      extracted_via: string
    } | null = null

    // Step 1: URL-param check on the lead URL itself. Modern review
    // sites often have the affiliate tag in their own outbound clicks
    // — but the lead URL is often the review page, which won't carry
    // it. Cheap to check.
    const directParsed = parseStagFromUrl(row.url)
    if (directParsed) {
      t1UrlParam++
      found = {
        s_tag: directParsed.tag,
        source_param: directParsed.param,
        brand: guessBrandFromUrl(row.url),
        tracking_url: row.url,
        final_url: row.url,
        extracted_via: 't1_url_param',
      }
    }

    // Step 2: HTML DEEP (fastest — regex over the raw text, no
    // network I/O).
    if (!found) {
      const deep = extractFromHtml(html)
      if (deep) {
        if (deep.extracted_via === 't1_html_next_data') t1NextData++
        else if (deep.extracted_via === 't1_html_data_attr') t1DataAttr++
        else if (deep.extracted_via === 't1_html_inline_js') t1InlineJs++
        found = {
          s_tag: deep.s_tag,
          source_param: deep.source_param,
          brand: guessBrandFromUrl(row.url),
          tracking_url: row.url,
          final_url: row.url,
          extracted_via: deep.extracted_via,
        }
      }
    }

    // Step 3: tracking-link fanout. Look at outbound tracking anchors
    // in the HTML and parse each one for an s-tag param (no redirect
    // follow — that's expensive and requires network).
    if (!found) {
      const links = findTrackingLinks(html, row.url)
      for (const link of links) {
        const parsed = parseStagFromUrl(link)
        if (!parsed) continue
        t1TrackingLink++
        found = {
          s_tag: parsed.tag,
          source_param: parsed.param,
          brand: guessBrandFromUrl(link),
          tracking_url: link,
          final_url: link,
          extracted_via: 't1_tracking_link',
        }
        break
      }
    }

    if (!found) {
      noHit++
      continue
    }

    if (APPLY) {
      const { error } = await s.rpc('replace_and_verify_s_tags_for_lead', {
        p_lead_id: row.lead_id,
        p_tags: [
          {
            s_tag: found.s_tag,
            source_param: found.source_param,
            brand: found.brand,
            tracking_url: found.tracking_url,
            final_url: found.final_url,
            redirect_chain: null,
            screenshot_path: null,
            extracted_via: found.extracted_via,
          },
        ],
      })
      if (error) {
        console.log(`  RPC failed for lead ${row.lead_id}: ${error.message}`)
        continue
      }
      persisted++
    }

    if (persisted % 100 === 0 && persisted > 0) {
      console.log(`  … ${persisted} leads updated`)
    }
  }

  const totalHits = t1UrlParam + t1NextData + t1DataAttr + t1InlineJs + t1TrackingLink
  console.log(`\n=== Re-extraction summary ===`)
  console.log(`  Processed:           ${workable.length}`)
  console.log(`  T1 URL-param match:  ${t1UrlParam}`)
  console.log(`  T1 NEXT_DATA / SSR:  ${t1NextData}`)
  console.log(`  T1 data-attr:        ${t1DataAttr}`)
  console.log(`  T1 inline JS:        ${t1InlineJs}`)
  console.log(`  T1 tracking-link:    ${t1TrackingLink}`)
  console.log(`  Total hits:          ${totalHits}   (${((totalHits / workable.length) * 100).toFixed(1)}% of processed)`)
  console.log(`  No hit:              ${noHit}`)
  if (APPLY) {
    console.log(`  Persisted:           ${persisted}`)
  } else {
    console.log(`  (Dry run — pass --apply to actually persist.)`)
  }
})().catch(e => { console.error(e); process.exit(1) })
