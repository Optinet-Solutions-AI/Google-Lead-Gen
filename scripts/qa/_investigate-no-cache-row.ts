/**
 * Why do 43.6% of is_affiliate leads have s_tags_checked_at set but
 * NO fetched_html_cache row? A few hypotheses:
 *
 * (a) cache is keyed by (lead_id, url) and the pipeline wrote the
 *     cache under a DIFFERENT url (e.g. a tracker url, not the
 *     lead url)
 * (b) fetched_html_cache has a TTL / cleanup that removed old rows
 * (c) the enrichment job never actually ran — s_tags_checked_at was
 *     stamped by an older code path or the RPC that fires on empty
 *     payloads (see 20260706120000_stag_preserve_tags_on_empty.sql)
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
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // Pick 10 leads with s_tags_checked_at set but no s_tag_id and see
  // if there's an enrichment queue entry, cache entry (any url), or
  // s_tags_table row.
  const { data: leadsRaw } = await s
    .from('google_lead_gen_table')
    .select('id, url, country_code, has_s_tags, s_tag_id, s_tags_checked_at, stag_check_checked_at, scrape_job_id')
    .eq('is_affiliate', true)
    .eq('has_s_tags', false)
    .not('s_tags_checked_at', 'is', null)
    .gte('s_tags_checked_at', since)
    .order('id', { ascending: false })
    .limit(30)
  const leads = ((leadsRaw ?? []) as Array<Record<string, unknown>>)
  console.log(`=== Sampling ${leads.length} recent leads with s_tags_checked_at but no s_tag ===\n`)

  for (const l of leads.slice(0, 10)) {
    console.log(`lead ${l.id}  url=${String(l.url).slice(0, 60)}`)
    console.log(`  s_tags_checked_at:     ${l.s_tags_checked_at}`)
    console.log(`  stag_check_checked_at: ${l.stag_check_checked_at}`)

    // 1) any fetched_html_cache row for this lead (ANY url)
    const { data: cache } = await s
      .from('fetched_html_cache')
      .select('url, fetch_error, fetched_at, html')
      .eq('lead_id', l.id)
    const cacheRows = ((cache ?? []) as Array<{ url: string; fetch_error: string | null; fetched_at: string; html: string | null }>)
    if (cacheRows.length === 0) {
      console.log(`  fetched_html_cache: (NONE for this lead_id)`)
    } else {
      for (const c of cacheRows) {
        const len = c.html?.length ?? 0
        console.log(`  fetched_html_cache: ${c.fetched_at}  err=${c.fetch_error ? c.fetch_error.slice(0, 40) : '-'}  html_len=${len}  cache_url=${c.url.slice(0, 60)}`)
      }
    }

    // 2) is there an enrichment_fetch_queue row for this lead?
    const { data: q } = await s
      .from('enrichment_fetch_queue')
      .select('id, status, error_message, process_stages, created_at, completed_at')
      .eq('lead_id', l.id)
      .order('created_at', { ascending: false })
      .limit(2)
    const qRows = ((q ?? []) as Array<Record<string, unknown>>)
    if (qRows.length === 0) console.log(`  enrichment_fetch_queue: (NONE — this lead was never enqueued for extraction!)`)
    else {
      for (const qr of qRows) {
        console.log(
          `  enrichment_fetch_queue: status=${qr.status}  stages=${JSON.stringify(qr.process_stages)}  created=${qr.created_at}  err=${qr.error_message ? String(qr.error_message).slice(0, 40) : '-'}`,
        )
      }
    }

    // 3) any s_tags_table rows for this lead
    const { data: tags } = await s
      .from('s_tags_table')
      .select('id, s_tag, source_param, extracted_via')
      .eq('lead_id', l.id)
    console.log(`  s_tags_table rows: ${(tags ?? []).length}`)
    console.log('')
  }

  // Aggregate: how many of the NO_CACHE_ROW bucket actually have
  // NO enrichment_fetch_queue row either?
  console.log('\n=== Aggregate: enrichment_fetch_queue presence for NO_CACHE_ROW bucket ===')
  const noQueueChecks = { sampled: 0, no_queue: 0, has_queue_failed: 0, has_queue_completed: 0, has_queue_other: 0 }
  for (const l of leads) {
    noQueueChecks.sampled++
    const { data: q } = await s
      .from('enrichment_fetch_queue')
      .select('status')
      .eq('lead_id', l.id)
      .contains('process_stages', ['stag'])
      .limit(1)
    const rows = ((q ?? []) as Array<{ status: string }>)
    if (rows.length === 0) noQueueChecks.no_queue++
    else if (rows[0]!.status === 'failed') noQueueChecks.has_queue_failed++
    else if (rows[0]!.status === 'completed') noQueueChecks.has_queue_completed++
    else noQueueChecks.has_queue_other++
  }
  console.log(JSON.stringify(noQueueChecks, null, 2))
})().catch(e => { console.error(e); process.exit(1) })
