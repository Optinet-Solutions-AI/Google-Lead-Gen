/**
 * Diagnose scrape jobs stuck in enrichment_status='affiliate_running'.
 *
 * Operator reported (2026-06-21): yesterday's scrapes — bar the
 * completed ones and one failure — all sit at "enriching affiliate".
 * Duration cells show only a few minutes of scrape work, so the
 * scrapes finished fine; the affiliate enrichment chain didn't.
 *
 *   npx tsx scripts/qa/diagnose-stuck-affiliate.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing supabase env')
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  console.log('=== Jobs in affiliate_running over the last 48h ===')
  const { data: stuck } = await svc
    .from('scrape_queue')
    .select('id, keyword, status, enrichment_status, completed_at, with_enrichment, created_by_display')
    .gte('completed_at', since)
    .eq('status', 'completed')
    .eq('enrichment_status', 'affiliate_running')
    .order('completed_at', { ascending: false })
    .limit(20)
  type J = {
    id: string
    keyword: string
    status: string
    enrichment_status: string
    completed_at: string
    with_enrichment: boolean
    created_by_display: string | null
  }
  const stuckJobs = (stuck ?? []) as J[]
  console.log(`Total: ${stuckJobs.length}`)
  for (const j of stuckJobs.slice(0, 10)) {
    console.log(`  ${j.id.slice(0, 8)}  ${j.completed_at}  ${j.created_by_display ?? '?'}  ${j.keyword.slice(0, 50)}`)
  }

  if (stuckJobs.length === 0) {
    console.log('(no stuck jobs found in this window)')
    return
  }

  // What does enrichment_fetch_queue say about these jobs?
  const jobIds = stuckJobs.map(j => j.id)

  console.log('\n=== Affiliate-stage rows for those jobs ===')
  const { data: eqRows } = await svc
    .from('enrichment_fetch_queue')
    .select('scrape_job_id, stage, status, attempts, error_message, claimed_by, updated_at')
    .in('scrape_job_id', jobIds)
    .eq('stage', 'affiliate')
  type ER = {
    scrape_job_id: string
    stage: string
    status: string
    attempts: number
    error_message: string | null
    claimed_by: string | null
    updated_at: string
  }
  const eq = (eqRows ?? []) as ER[]

  const byStatus = new Map<string, number>()
  for (const r of eq) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
  console.log('Row counts by status:', Object.fromEntries(byStatus))

  console.log('\n=== Affiliate-stage rows still pending or running (first 10) ===')
  const inflight = eq.filter(r => r.status === 'pending' || r.status === 'running')
  for (const r of inflight.slice(0, 10)) {
    console.log(
      `  job=${r.scrape_job_id.slice(0, 8)}  status=${r.status}  attempts=${r.attempts}  ` +
        `claimed_by=${r.claimed_by ?? '-'}  updated_at=${r.updated_at}`,
    )
  }

  console.log('\n=== When did the affiliate stage last move on ANY job? ===')
  const { data: latest } = await svc
    .from('enrichment_fetch_queue')
    .select('updated_at, status, stage, claimed_by')
    .eq('stage', 'affiliate')
    .in('status', ['completed', 'failed'])
    .order('updated_at', { ascending: false })
    .limit(5)
  for (const r of (latest ?? []) as Array<{ updated_at: string; status: string; claimed_by: string | null }>) {
    console.log(`  ${r.updated_at}  status=${r.status}  worker=${r.claimed_by ?? '-'}`)
  }

  console.log('\n=== Any failed affiliate rows in window? ===')
  const { data: failed } = await svc
    .from('enrichment_fetch_queue')
    .select('scrape_job_id, error_message, updated_at, attempts')
    .eq('stage', 'affiliate')
    .eq('status', 'failed')
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(10)
  for (const r of (failed ?? []) as Array<{
    scrape_job_id: string
    error_message: string | null
    updated_at: string
    attempts: number
  }>) {
    console.log(
      `  job=${r.scrape_job_id.slice(0, 8)}  attempts=${r.attempts}  ` +
        `err=${(r.error_message ?? '').slice(0, 100)}`,
    )
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
