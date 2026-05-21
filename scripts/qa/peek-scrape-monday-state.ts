/**
 * Check whether the Monday duplicate check has run on scrape job
 * 44b60a37 (Charisse's QA report on lead 12530). Looks at the
 * monday_checked_at distribution across all leads in that scrape.
 * Read-only.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const jobId = '44b60a37-29f4-4eeb-81b8-786bb8aeee0c'

  const { data: job } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, status, created_at, completed_at, created_by_display, with_enrichment')
    .eq('id', jobId)
    .maybeSingle()
  console.log('--- scrape_queue row ---')
  console.log(JSON.stringify(job, null, 2))

  // Aggregate per-lead Monday state
  const { data: leads, error } = await svc
    .from('google_lead_gen_table')
    .select('id, is_on_monday, monday_board, monday_checked_at, monday_overridden_at')
    .eq('scrape_job_id', jobId)
  if (error) throw error

  let total = 0
  let checked = 0
  let unchecked = 0
  let onMonday = 0
  let notOnMonday = 0
  let nullIsOnMonday = 0
  for (const l of (leads ?? []) as Array<{ is_on_monday: boolean | null; monday_checked_at: string | null }>) {
    total++
    if (l.monday_checked_at) checked++; else unchecked++
    if (l.is_on_monday === true) onMonday++
    else if (l.is_on_monday === false) notOnMonday++
    else nullIsOnMonday++
  }
  console.log(`\n--- Lead Monday state for scrape ${jobId} ---`)
  console.log(`total=${total}`)
  console.log(`monday_checked_at set: ${checked}`)
  console.log(`monday_checked_at null: ${unchecked}`)
  console.log(`is_on_monday true:  ${onMonday}`)
  console.log(`is_on_monday false: ${notOnMonday}`)
  console.log(`is_on_monday null:  ${nullIsOnMonday}`)

  // What does the EnrichmentStages view show for this job?
  const { data: stageRow } = await svc
    .from('enrichment_stage_runs')
    .select('*')
    .eq('scrape_job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(20)
  console.log(`\n--- enrichment_stage_runs (${stageRow?.length ?? 0}) ---`)
  for (const r of stageRow ?? []) console.log(JSON.stringify(r))
}

main().catch(e => { console.error(e); process.exit(1) })
