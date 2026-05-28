/**
 * Quick check: for batch 736's failed queue rows, how many attempts
 * did each one actually make? max_attempts defaults to 3, so if rows
 * failed at attempts=1 something is shortcutting the retry loop.
 *
 * Read-only. Run: npx tsx scripts/qa/check-retry-attempts.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const JOB_ID = 'a75ae289-84d4-4adf-a5a9-56a5aee6daaf'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: leads } = await svc
    .from('google_lead_gen_table')
    .select('id')
    .eq('scrape_job_id', JOB_ID)
  const leadIds = (leads ?? []).map((l: { id: number }) => l.id)

  const { data: queue } = await svc
    .from('enrichment_fetch_queue')
    .select('lead_id, process_stages, status, attempts, max_attempts')
    .in('lead_id', leadIds)
    .eq('status', 'failed')

  type Row = { lead_id: number; process_stages: unknown; status: string; attempts: number; max_attempts: number }
  const rows = (queue ?? []) as Row[]
  const counts: Record<string, number> = {}
  for (const r of rows) {
    const key = `attempts=${r.attempts}/${r.max_attempts}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  console.log(`Failed queue rows by attempts/max_attempts:`)
  for (const [k, n] of Object.entries(counts).sort()) {
    console.log(`  ${k.padEnd(20)} ${n}`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
