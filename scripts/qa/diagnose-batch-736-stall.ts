/**
 * Diagnose why 13/25 rows in batch 736 have is_affiliate=null
 * 30h+ after the scrape completed. Looking for:
 *  - scrape_queue.enrichment_status (did the chain ever start? finish?)
 *  - per-lead enrichment_fetch_queue entries (enqueued at all? status?)
 *  - error messages on failed queue rows
 *
 * Read-only. Run: npx tsx scripts/qa/diagnose-batch-736-stall.ts
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

  // 1. scrape_queue state for this job
  const { data: job, error: jErr } = await svc
    .from('scrape_queue')
    .select(
      'id, status, with_enrichment, enrichment_status, enrichment_started_at, enrichment_completed_at, completed_at, created_at, batch_id, keyword',
    )
    .eq('id', JOB_ID)
    .maybeSingle()
  if (jErr) throw jErr
  console.log('=== scrape_queue ===')
  console.log(JSON.stringify(job, null, 2))

  // 2. All leads in the job + their per-lead enrichment state
  type Lead = {
    id: number
    domain: string | null
    is_affiliate: boolean | null
    is_not_relevant: boolean
    affiliate_checked_at: string | null
    rooster_checked_at: string | null
    is_affiliate_overridden_at: string | null
    url: string | null
    country_code: string | null
  }
  const { data: leadsRaw, error: lErr } = await svc
    .from('google_lead_gen_table')
    .select(
      'id, domain, is_affiliate, is_not_relevant, affiliate_checked_at, rooster_checked_at, is_affiliate_overridden_at, url, country_code',
    )
    .eq('scrape_job_id', JOB_ID)
  if (lErr) throw lErr
  const leads = (leadsRaw ?? []) as Lead[]
  const leadIds = leads.map(l => l.id)
  console.log(`\n=== leads in job: ${leads.length} ===`)

  // 3. enrichment_fetch_queue rows for these leads
  type QRow = {
    id: number
    lead_id: number
    process_stages: unknown
    status: string
    attempts: number
    max_attempts: number
    error_message: string | null
    updated_at: string
  }
  const { data: qRaw, error: qErr } = await svc
    .from('enrichment_fetch_queue')
    .select('id, lead_id, process_stages, status, attempts, max_attempts, error_message, updated_at')
    .in('lead_id', leadIds)
  if (qErr) throw qErr
  const queue = (qRaw ?? []) as QRow[]
  console.log(`=== fetch-queue rows: ${queue.length} ===\n`)

  // Per-stage status breakdown
  const stageStatus: Record<string, Record<string, number>> = {}
  for (const r of queue) {
    const stages = Array.isArray(r.process_stages)
      ? (r.process_stages as string[])
      : (JSON.parse((r.process_stages as string) ?? '[]') as string[])
    for (const s of stages) {
      stageStatus[s] ??= {}
      stageStatus[s][r.status] = (stageStatus[s][r.status] ?? 0) + 1
    }
  }
  console.log('Queue rows by stage × status:')
  for (const [stage, st] of Object.entries(stageStatus)) {
    console.log(`  ${stage.padEnd(10)} ${JSON.stringify(st)}`)
  }

  // Per-lead summary — which leads have no queue row at all?
  const queueByLead = new Map<number, QRow[]>()
  for (const r of queue) {
    if (!queueByLead.has(r.lead_id)) queueByLead.set(r.lead_id, [])
    queueByLead.get(r.lead_id)!.push(r)
  }
  const leadsNoQueue = leads.filter(l => !queueByLead.has(l.id))
  console.log(`\nLeads with NO queue row at all: ${leadsNoQueue.length}`)
  for (const l of leadsNoQueue) {
    console.log(
      `  lead=${l.id} aff=${l.is_affiliate} notRel=${l.is_not_relevant} aff_at=${l.affiliate_checked_at ?? '—'} domain=${l.domain}`,
    )
  }

  // Aff=null leads — what does their queue look like?
  const affNullLeads = leads.filter(l => l.is_affiliate === null && l.affiliate_checked_at === null)
  console.log(`\nLeads with is_affiliate=null AND affiliate_checked_at=null: ${affNullLeads.length}`)
  for (const l of affNullLeads) {
    const qs = queueByLead.get(l.id) ?? []
    const affQs = qs.filter(q => {
      const stages = Array.isArray(q.process_stages)
        ? (q.process_stages as string[])
        : (JSON.parse((q.process_stages as string) ?? '[]') as string[])
      return stages.includes('affiliate')
    })
    if (affQs.length === 0) {
      console.log(`  lead=${l.id} notRel=${l.is_not_relevant} url=${l.url} — NO affiliate queue row`)
    } else {
      for (const q of affQs) {
        const errMsg = q.error_message ? ` err="${q.error_message.slice(0, 80)}"` : ''
        console.log(
          `  lead=${l.id} notRel=${l.is_not_relevant} q=${q.status} att=${q.attempts}/${q.max_attempts}${errMsg} url=${l.url}`,
        )
      }
    }
  }

  // Was enrichment ever started? Time math.
  if (job?.enrichment_started_at) {
    const startMs = new Date(job.enrichment_started_at).getTime()
    const compMs = job.enrichment_completed_at
      ? new Date(job.enrichment_completed_at).getTime()
      : Date.now()
    const dur = ((compMs - startMs) / 60000).toFixed(1)
    console.log(`\nEnrichment ran for ${dur} minutes (status=${job.enrichment_status}).`)
  } else {
    console.log('\nEnrichment NEVER started for this job (enrichment_started_at is null).')
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
