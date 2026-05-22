/**
 * One-off: operational snapshot of S-tag enrichment after the proxy
 * outage on 2026-05-22. Answers "is S-tag actually producing tags?"
 *
 *   1. enrichment_fetch_queue rows with 'stag' in process_stages,
 *      bucketed by status over the last 24h.
 *   2. s_tags_table inserts in the last 24h: total rows, distinct
 *      leads, extracted_via breakdown (desktop vs mobile vs null).
 *   3. Top failure messages from failed S-tag queue rows in 7d.
 *   4. Sample of recently-checked leads with zero tags — the
 *      "ran but found nothing" bucket the operator complaints describe.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

  const [qRes, tagRes, leadRes] = await Promise.all([
    svc.from('enrichment_fetch_queue')
      .select('lead_id, status, attempts, max_attempts, process_stages, error_message, updated_at')
      .filter('process_stages', 'cs', '["stag"]')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(2000),
    svc.from('s_tags_table')
      .select('id, lead_id, extracted_via, created_at')
      .gte('created_at', since)
      .limit(5000),
    svc.from('google_lead_gen_table')
      .select('id, url, s_tags_checked_at')
      .gte('s_tags_checked_at', since)
      .order('s_tags_checked_at', { ascending: false })
      .limit(500),
  ])
  if (qRes.error) { console.error('queue err', qRes.error); process.exit(1) }
  if (tagRes.error) { console.error('tags err', tagRes.error); process.exit(1) }
  if (leadRes.error) { console.error('leads err', leadRes.error); process.exit(1) }
  const qRows = qRes.data ?? []
  const tagRows = tagRes.data ?? []
  const checkedLeads = leadRes.data ?? []

  // 1. Queue activity for stag stage in last 7d.
  const byStatus: Record<string, number> = {}
  for (const r of qRows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  console.log(`\n=== S-tag queue rows updated in last 7d: ${qRows.length} ===`)
  console.log('  by status:', byStatus)

  // 2. Tags inserted in last 7d.
  const distinctLeads = new Set(tagRows.map(r => r.lead_id)).size
  const viaCounts: Record<string, number> = {}
  for (const r of tagRows) {
    const k = r.extracted_via ?? '(null)'
    viaCounts[k] = (viaCounts[k] ?? 0) + 1
  }
  console.log(`\n=== s_tags_table inserts in last 7d: ${tagRows.length} rows across ${distinctLeads} leads ===`)
  console.log('  extracted_via:', viaCounts)

  // 3. Top failure messages on failed stag rows in 7d.
  const failed = qRows.filter(r => r.status === 'failed')
  console.log(`\n=== Failed S-tag jobs in 7d: ${failed.length} ===`)
  const errCounts: Record<string, number> = {}
  for (const r of failed) {
    const firstLine = ((r.error_message ?? '') as string).split('\n')[0] ?? ''
    const k = firstLine.slice(0, 140) || '(empty)'
    errCounts[k] = (errCounts[k] ?? 0) + 1
  }
  for (const [k, v] of Object.entries(errCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${v}× ${k}`)
  }

  // 4. Recently-checked leads with zero tags. Reuses tagRows above —
  // tags from an enrichment run land in the same 7d window as the
  // s_tags_checked_at bump, so a tag-less lead here means "this run
  // produced nothing", which is exactly the bucket we care about.
  const leadsWithTags = new Set(tagRows.map(r => r.lead_id as number))
  const zeroTagLeads = checkedLeads.filter(l => !leadsWithTags.has(l.id))
  console.log(`\n=== Leads with s_tags_checked_at in 7d: ${checkedLeads.length}, of which 0 tags landed: ${zeroTagLeads.length} ===`)
  console.log('  sample (first 5 zero-tag URLs):')
  for (const l of zeroTagLeads.slice(0, 5)) {
    console.log(`    lead ${l.id}  ${String(l.url).slice(0, 80)}  checked=${l.s_tags_checked_at}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
