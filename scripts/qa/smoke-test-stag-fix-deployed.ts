/**
 * Post-deploy smoke test for the same-host stag fix.
 *
 *   1. Picks lead 9733 (footitalia.com/gambling-sites/golden-panda/, IT)
 *      — a known affiliate-review URL that returned 0 tags in the
 *      prior 7d window. Offline curl verified the patched extractor
 *      finds the /visit/goldenpanda/ tracking link.
 *   2. Snapshots the lead's current tag count (sanity baseline).
 *   3. Enqueues an enrichment_fetch_queue row with process_stages=['stag'].
 *   4. Polls the queue row every 5s until status is 'completed' or
 *      'failed', or until a 5-minute hard cap.
 *   5. Re-queries s_tags_table for the lead and reports what landed.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
loadEnv({ path: join(process.cwd(), '.env.local') })

const TARGET_LEAD_ID = 9733
const POLL_MS = 5_000
const TIMEOUT_MS = 5 * 60_000

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  // Step 1: load the lead so we know its url + country_code.
  const { data: lead, error: le } = await svc
    .from('google_lead_gen_table')
    .select('id, url, country_code, s_tags_checked_at')
    .eq('id', TARGET_LEAD_ID)
    .single()
  if (le || !lead) { console.error('lead lookup failed', le); process.exit(1) }
  console.log(`lead: ${lead.id}  ${lead.url}  country=${lead.country_code}  last_checked=${lead.s_tags_checked_at}`)

  // Step 2: snapshot existing tags.
  const { data: existingTags } = await svc
    .from('s_tags_table')
    .select('id, s_tag, source_param, brand, extracted_via, created_at')
    .eq('lead_id', lead.id)
  console.log(`existing tags on this lead: ${existingTags?.length ?? 0}`)
  for (const t of existingTags ?? []) console.log(`  ${t.s_tag} (${t.source_param}, ${t.extracted_via}, ${t.created_at})`)

  // Step 3: enqueue a stag-only job.
  const enqueueStartedAt = new Date().toISOString()
  const { data: queued, error: qe } = await svc
    .from('enrichment_fetch_queue')
    .insert({
      lead_id: lead.id,
      country_code: lead.country_code,
      url: lead.url,
      process_stages: ['stag'],
      want_html: false,
      want_screenshot: false,
      status: 'pending',
    })
    .select()
    .single()
  if (qe || !queued) { console.error('enqueue failed', qe); process.exit(1) }
  console.log(`\nqueued: job=${queued.id}  status=${queued.status}  at=${queued.created_at}`)

  // Step 4: poll until terminal.
  const deadline = Date.now() + TIMEOUT_MS
  let lastStatus = queued.status
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS))
    const { data: row } = await svc
      .from('enrichment_fetch_queue')
      .select('status, attempts, claimed_by, started_at, completed_at, error_message')
      .eq('id', queued.id)
      .single()
    if (!row) { console.log('  (queue row gone)'); break }
    if (row.status !== lastStatus) {
      console.log(`  status: ${lastStatus} → ${row.status}  claimed_by=${row.claimed_by ?? '-'}  attempts=${row.attempts}`)
      lastStatus = row.status
    } else {
      console.log(`  ...still ${row.status}  attempts=${row.attempts}`)
    }
    if (row.status === 'completed' || row.status === 'failed') {
      if (row.error_message) console.log(`  error_message: ${row.error_message}`)
      console.log(`  started=${row.started_at}  completed=${row.completed_at}`)
      break
    }
  }
  if (Date.now() >= deadline) console.log('  TIMEOUT after 5 min')

  // Step 5: re-query tags inserted since enqueue.
  const { data: newTags } = await svc
    .from('s_tags_table')
    .select('id, s_tag, source_param, brand, extracted_via, tracking_url, final_url, screenshot_path, created_at')
    .eq('lead_id', lead.id)
    .gte('created_at', enqueueStartedAt)
    .order('created_at', { ascending: true })
  console.log(`\n=== RESULT ===`)
  console.log(`tags inserted since enqueue: ${newTags?.length ?? 0}`)
  for (const t of newTags ?? []) {
    console.log(`  s_tag=${t.s_tag}  param=${t.source_param}  brand=${t.brand}  via=${t.extracted_via}`)
    console.log(`    tracking=${t.tracking_url}`)
    console.log(`    final=${t.final_url}`)
    if (t.screenshot_path) console.log(`    screenshot=${t.screenshot_path}`)
  }
  if ((newTags?.length ?? 0) === 0) {
    console.log('\n  → still zero tags. Worker logs on the VM will tell us what stage failed.')
    console.log(`     ssh: journalctl -u 'enrichment-worker@*' --since '5 min ago' | grep -i 'lead=${lead.id}\\|stag'`)
  } else {
    console.log('\n  → fix works end-to-end. Lead row should now show the s-tag(s) in the UI.')
  }
}
main().catch(e => { console.error(e); process.exit(1) })
