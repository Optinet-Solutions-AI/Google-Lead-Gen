import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { persistSession: false } })

  console.log('=== Stuck jobs (full IDs) + lead counts + queued enrichment-fetch rows ===')
  const { data: stuck } = await svc
    .from('scrape_queue')
    .select('id, keyword, enrichment_status, completed_at')
    .eq('status', 'completed')
    .eq('enrichment_status', 'affiliate_running')
    .gte('completed_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
    .order('completed_at', { ascending: false })
    .limit(10)
  type J = { id: string; keyword: string; enrichment_status: string; completed_at: string }
  const jobs = (stuck ?? []) as J[]

  for (const j of jobs) {
    const { data: leads } = await svc
      .from('google_lead_gen_table')
      .select('id, affiliate_checked_at, is_affiliate, is_on_monday, is_not_relevant')
      .eq('scrape_job_id', j.id)
    const leadRows = (leads ?? []) as Array<{
      id: number
      affiliate_checked_at: string | null
      is_affiliate: boolean | null
      is_on_monday: boolean | null
      is_not_relevant: boolean | null
    }>
    const leadIds = leadRows.map(l => l.id)
    const checked = leadRows.filter(l => l.affiliate_checked_at).length
    const onMonday = leadRows.filter(l => l.is_on_monday).length
    const notRel = leadRows.filter(l => l.is_not_relevant).length

    let queuedAff = 0
    let queuedPending = 0
    let queuedRunning = 0
    let queuedCompleted = 0
    let queuedFailed = 0
    if (leadIds.length > 0) {
      const { data: efq } = await svc
        .from('enrichment_fetch_queue')
        .select('id, status, process_stages, claimed_by, attempts, updated_at')
        .in('lead_id', leadIds)
      const efqRows = (efq ?? []) as Array<{
        id: string
        status: string
        process_stages: unknown
        claimed_by: string | null
        attempts: number
        updated_at: string
      }>
      for (const r of efqRows) {
        const stages = Array.isArray(r.process_stages) ? r.process_stages as string[] : []
        if (stages.includes('affiliate')) {
          queuedAff += 1
          if (r.status === 'pending') queuedPending += 1
          else if (r.status === 'running') queuedRunning += 1
          else if (r.status === 'completed') queuedCompleted += 1
          else if (r.status === 'failed') queuedFailed += 1
        }
      }
    }
    console.log(
      `  ${j.id.slice(0, 8)}  ${j.completed_at.slice(0, 19)}  leads=${leadRows.length}  ` +
      `aff_checked=${checked}  on_monday=${onMonday}  not_rel=${notRel}  | ` +
      `efq_aff=${queuedAff} (pend=${queuedPending} run=${queuedRunning} ` +
      `done=${queuedCompleted} fail=${queuedFailed})  ${j.keyword.slice(0, 30)}`,
    )
  }

  console.log('\n=== Overall efq health: last 10 rows ===')
  const { data: last } = await svc
    .from('enrichment_fetch_queue')
    .select('id, lead_id, status, claimed_by, created_at, updated_at, process_stages')
    .order('created_at', { ascending: false })
    .limit(10)
  for (const r of (last ?? []) as Array<{
    id: string
    lead_id: number
    status: string
    claimed_by: string | null
    created_at: string
    updated_at: string
    process_stages: unknown
  }>) {
    console.log(
      `  lead=${r.lead_id} ${r.status} claimed=${r.claimed_by ?? '-'} ` +
      `created=${r.created_at.slice(0, 19)} updated=${r.updated_at.slice(0, 19)} ` +
      `stages=${JSON.stringify(r.process_stages)}`,
    )
  }

  console.log('\n=== Counts in efq last 7d, by status ===')
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  for (const s of ['pending', 'running', 'completed', 'failed']) {
    const { count } = await svc
      .from('enrichment_fetch_queue')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since7)
      .eq('status', s)
    console.log(`  ${s.padEnd(10)}  ${count}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
