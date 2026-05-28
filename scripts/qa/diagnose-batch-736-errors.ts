/**
 * Drill into the per-queue-row error_message for batch 736's failed
 * affiliate + rooster fetches. We saw 11 of 23 affiliate fetches
 * failed and 16 of 23 rooster fetches failed — looking for the root
 * cause pattern (timeout, captcha, parse, target blocked, etc.).
 *
 * Read-only. Run: npx tsx scripts/qa/diagnose-batch-736-errors.ts
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

  type Lead = { id: number; domain: string | null; url: string | null }
  const { data: leadsRaw } = await svc
    .from('google_lead_gen_table')
    .select('id, domain, url')
    .eq('scrape_job_id', JOB_ID)
  const leads = (leadsRaw ?? []) as Lead[]
  const leadIds = leads.map(l => l.id)
  const leadDom = new Map(leads.map(l => [l.id, l.domain ?? l.url ?? '?']))

  type QRow = {
    lead_id: number
    process_stages: unknown
    status: string
    attempts: number
    error_message: string | null
  }
  const { data: qRaw } = await svc
    .from('enrichment_fetch_queue')
    .select('lead_id, process_stages, status, attempts, error_message')
    .in('lead_id', leadIds)
    .eq('status', 'failed')
  const failed = (qRaw ?? []) as QRow[]

  // Group errors
  const byErr: Record<string, Array<{ stage: string; domain: string }>> = {}
  for (const r of failed) {
    const stages = Array.isArray(r.process_stages)
      ? (r.process_stages as string[])
      : (JSON.parse((r.process_stages as string) ?? '[]') as string[])
    const e = (r.error_message ?? '<no message>').trim()
    // Normalize: first ~120 chars to group similar errors
    const key = e.slice(0, 120)
    byErr[key] ??= []
    byErr[key].push({ stage: stages.join(','), domain: leadDom.get(r.lead_id) ?? '?' })
  }

  console.log(`Total failed queue rows: ${failed.length}\n`)
  for (const [err, rows] of Object.entries(byErr).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`──── ${rows.length}× ────`)
    console.log(`  error: ${err}`)
    for (const r of rows.slice(0, 8)) {
      console.log(`    [${r.stage}] ${r.domain}`)
    }
    if (rows.length > 8) console.log(`    ... ${rows.length - 8} more`)
    console.log()
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
