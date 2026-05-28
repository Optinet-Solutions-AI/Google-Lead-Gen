/**
 * One-shot: re-enqueue the 27 failed affiliate + rooster fetches
 * for batch 736 so the (now-healthy) workers fill in the missing
 * is_affiliate / is_rooster_partner values.
 *
 * The migration 20260528210000_enrichment_fetch_retry_on_error.sql
 * stops new scrapes from hitting this state, but those 27 rows
 * pre-date the fix — they need a manual nudge.
 *
 * Strategy: INSERT new enrichment_fetch_queue rows (status=pending,
 * attempts=0) for each (lead_id, stage) pair that previously
 * failed. The workers pick them up via claim_enrichment_fetch_job
 * on their normal poll cycle. Existing failed rows are left
 * untouched as a historical record.
 *
 * Read-only by default; pass --apply to actually insert.
 * Run: npx tsx scripts/qa/requeue-batch-736-failures.ts [--apply]
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const JOB_ID = 'a75ae289-84d4-4adf-a5a9-56a5aee6daaf'
const APPLY = process.argv.includes('--apply')

type Lead = {
  id: number
  url: string | null
  country_code: string | null
  result_type: string | null
  is_affiliate: boolean | null
  is_not_relevant: boolean
}

type QRow = {
  lead_id: number
  process_stages: unknown
  status: string
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: leadsRaw } = await svc
    .from('google_lead_gen_table')
    .select('id, url, country_code, result_type, is_affiliate, is_not_relevant')
    .eq('scrape_job_id', JOB_ID)
  const leads = (leadsRaw ?? []) as Lead[]
  const leadIds = leads.map(l => l.id)
  const leadById = new Map(leads.map(l => [l.id, l]))

  const { data: qRaw } = await svc
    .from('enrichment_fetch_queue')
    .select('lead_id, process_stages, status')
    .in('lead_id', leadIds)
    .eq('status', 'failed')
  const failed = (qRaw ?? []) as QRow[]

  // Collect unique (lead, stage) pairs to retry. Skip:
  //  - leads that already have a completed row for that stage
  //    (another retry already succeeded by hand)
  //  - leads with no URL or no country
  //  - not-relevant leads (operator/Monday — no point enriching)
  const { data: completedRaw } = await svc
    .from('enrichment_fetch_queue')
    .select('lead_id, process_stages, status')
    .in('lead_id', leadIds)
    .eq('status', 'completed')
  const completed = (completedRaw ?? []) as QRow[]
  const completedKeys = new Set(
    completed.flatMap(c => {
      const stages = Array.isArray(c.process_stages)
        ? (c.process_stages as string[])
        : (JSON.parse((c.process_stages as string) ?? '[]') as string[])
      return stages.map(s => `${c.lead_id}:${s}`)
    }),
  )

  const wanted: Array<{
    lead_id: number
    country_code: string
    url: string
    want_html: boolean
    want_screenshot: boolean
    process_stages: string[]
  }> = []
  const skipped: Array<{ lead_id: number; stage: string; reason: string }> = []

  for (const f of failed) {
    const stages = Array.isArray(f.process_stages)
      ? (f.process_stages as string[])
      : (JSON.parse((f.process_stages as string) ?? '[]') as string[])
    for (const stage of stages) {
      const lead = leadById.get(f.lead_id)
      if (!lead) continue
      if (completedKeys.has(`${f.lead_id}:${stage}`)) {
        skipped.push({ lead_id: f.lead_id, stage, reason: 'already_completed' })
        continue
      }
      if (lead.is_not_relevant) {
        skipped.push({ lead_id: f.lead_id, stage, reason: 'not_relevant' })
        continue
      }
      if (!lead.url || !lead.url.startsWith('http')) {
        skipped.push({ lead_id: f.lead_id, stage, reason: 'no_url' })
        continue
      }
      if (!lead.country_code) {
        skipped.push({ lead_id: f.lead_id, stage, reason: 'no_country' })
        continue
      }
      wanted.push({
        lead_id: f.lead_id,
        country_code: lead.country_code,
        url: lead.url,
        want_html: true,
        want_screenshot: stage === 'affiliate' && lead.result_type === 'PPC',
        process_stages: [stage],
      })
    }
  }

  console.log(`Failed queue rows: ${failed.length}`)
  console.log(`Would requeue:     ${wanted.length}`)
  console.log(`Skipped:           ${skipped.length}`)
  const byReason: Record<string, number> = {}
  for (const s of skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1
  for (const [r, n] of Object.entries(byReason)) console.log(`  ${r}: ${n}`)

  if (!APPLY) {
    console.log(`\n(dry-run — pass --apply to actually insert)`)
    return
  }
  if (wanted.length === 0) {
    console.log(`\nNothing to requeue.`)
    return
  }

  const { error: insErr, count } = await svc
    .from('enrichment_fetch_queue')
    .insert(wanted, { count: 'exact' })
  if (insErr) throw insErr
  console.log(`\nInserted ${count ?? wanted.length} new queue rows.`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
