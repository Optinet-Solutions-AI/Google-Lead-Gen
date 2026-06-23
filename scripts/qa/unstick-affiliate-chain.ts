/**
 * One-shot recovery: find scrape jobs stuck in
 * enrichment_status='affiliate_running' (or 'all_running') where
 * NO enrichment_fetch_queue row for that job is still pending/
 * running/paused, then call advance_enrichment_chain on each so the
 * status flips to the correct terminal value.
 *
 *   npx tsx scripts/qa/unstick-affiliate-chain.ts
 *
 * Safe to run any time — advance_enrichment_chain is idempotent and
 * a no-op for jobs that aren't actually stuck.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const { data: stuck } = await svc
    .from('scrape_queue')
    .select('id, keyword, enrichment_status, completed_at')
    .eq('status', 'completed')
    .in('enrichment_status', ['affiliate_running', 'all_running'])
    .order('completed_at', { ascending: false })
    .limit(500)
  type J = { id: string; keyword: string; enrichment_status: string; completed_at: string }
  const jobs = (stuck ?? []) as J[]
  console.log(`Found ${jobs.length} jobs in *_running state. Running advance_enrichment_chain on each…`)

  let advanced = 0
  let unchanged = 0
  for (const j of jobs) {
    const { data, error } = await svc.rpc('advance_enrichment_chain', { p_job_id: j.id })
    if (error) {
      console.log(`  ${j.id.slice(0, 8)}  ERROR  ${error.message}`)
      continue
    }
    const after = typeof data === 'string' ? data : String(data)
    if (after !== j.enrichment_status) {
      console.log(`  ${j.id.slice(0, 8)}  ${j.enrichment_status} -> ${after}  ${j.keyword.slice(0, 40)}`)
      advanced += 1
    } else {
      unchanged += 1
    }
  }
  console.log(`\nAdvanced: ${advanced}   Unchanged (still has pending work): ${unchanged}`)
}

main().catch(err => { console.error(err); process.exit(1) })
