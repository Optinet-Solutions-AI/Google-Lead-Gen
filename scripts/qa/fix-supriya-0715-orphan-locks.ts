/**
 * Remediation for Supriya's 2026-07-15 "scrapes failing after retries" report.
 *
 * Frees the two ORPHANED needs_human locks (NZ + IE, held by vm2-9223 since
 * 2026-07-14) and re-queues her stuck Google gambling jobs. Uses
 * requeue_scrape_after_hitl, which deletes the active_profile_lock, resets
 * counters, and sets the job back to 'pending' for a fresh attempt.
 *
 * Bing "captcha - 10 retries" jobs are intentionally NOT re-queued here — those
 * are proxy-reputation blocks on gambling SERPs, not lock orphans; re-running
 * would just re-fail and burn proxy quota.
 *
 * Set APPLY=1 to mutate; default is a dry run.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

// Distinct stuck Google jobs (dedup by keyword+country). The first two hold the
// orphaned per-country locks and MUST be included to free NZ / IE.
const JOB_IDS = [
  '0cbc42d3-f20d-4171-993a-0545cb2a51b1', // NZ needs_human — holds NZ lock
  '2c25ae1d-f996-4bb6-bc9e-2f4571d65375', // IE needs_human — holds IE lock
  'fb03016f-06dc-49eb-90d9-24faa7631d78', // IE failed  "online casino ireland"
  'a6b2cdf6-d58c-4e41-9dc3-dacff9d8ca57', // IE failed  "ireland casino"
  '4948acf0-0f16-44c2-bdb9-df9442277527', // DE failed  "neue online casinos" (took too long)
]

async function main() {
  const apply = process.env.APPLY === '1'
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log(`mode: ${apply ? 'APPLY' : 'DRY RUN (set APPLY=1 to mutate)'}\n`)

  console.log('=== locks BEFORE ===')
  const { data: before } = await svc.from('active_profile_locks').select('*')
  for (const l of before ?? []) console.log('  ', JSON.stringify(l))
  if (!before?.length) console.log('  (none)')

  console.log('\n=== target jobs ===')
  const { data: jobs } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, search_engine, status')
    .in('id', JOB_IDS)
  for (const j of jobs ?? [])
    console.log(`  [${j.search_engine} ${j.country_code}] "${j.keyword}"  status=${j.status}  ${j.id}`)

  if (!apply) {
    console.log('\nDry run — no changes. Re-run with APPLY=1.')
    return
  }

  console.log('\n=== requeue ===')
  for (const id of JOB_IDS) {
    const { data, error } = await svc.rpc('requeue_scrape_after_hitl', { p_job_id: id })
    console.log(`  ${id}: ${error ? `ERR ${error.message}` : `ok (was ${data})`}`)
  }

  console.log('\n=== locks AFTER ===')
  const { data: after } = await svc.from('active_profile_locks').select('*')
  for (const l of after ?? []) console.log('  ', JSON.stringify(l))
  if (!after?.length) console.log('  (none — all released)')
}
main().catch(e => { console.error(e); process.exit(1) })
