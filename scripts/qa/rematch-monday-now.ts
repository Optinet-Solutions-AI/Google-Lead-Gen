/**
 * One-shot: call rematch_monday_for_all_leads(50000) to flip the
 * is_on_monday flag on every lead whose match would now succeed
 * against the current Monday replica.
 *
 * Use after applying 20260623000000_monday_rematch.sql, OR any time
 * the replica looks freshly synced and operators report stale "not
 * on Monday" labels.
 *
 *   npx tsx scripts/qa/rematch-monday-now.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const t0 = Date.now()
  const { data, error } = await svc.rpc('rematch_monday_for_all_leads', { p_limit: 50_000 })
  if (error) {
    console.error('rematch failed:', error)
    process.exit(1)
  }
  const row = Array.isArray(data) ? (data[0] as { checked?: number; flipped?: number } | undefined) : undefined
  console.log(`rematch done in ${Date.now() - t0}ms: checked=${row?.checked ?? 0}, flipped=${row?.flipped ?? 0}`)
}

main().catch(err => { console.error(err); process.exit(1) })
