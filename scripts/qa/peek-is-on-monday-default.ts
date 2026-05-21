/**
 * Quick check: what does is_on_monday default to on the table, and how
 * many rows are null/true/false? Helps verify whether the planned
 * backfill in 20260522050000 is safe (the backfill uses
 * `where is_on_monday is not null`).
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

  const { count: totalCount } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })

  const { count: nullCount } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .is('is_on_monday', null)

  const { count: nullCheckedButOnMonday } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .is('monday_checked_at', null)
    .not('is_on_monday', 'is', null)

  const { count: nullCheckedAtAll } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .is('monday_checked_at', null)

  const { count: matchedNoTimestamp } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .is('monday_checked_at', null)
    .not('monday_item_id', 'is', null)

  console.log('total                                :', totalCount)
  console.log('is_on_monday is null                  :', nullCount)
  console.log('monday_checked_at null                :', nullCheckedAtAll)
  console.log('monday_checked_at null AND is_on_monday set :', nullCheckedButOnMonday)
  console.log('monday_checked_at null AND monday_item_id set (definitely Monday-matched, no stamp) :', matchedNoTimestamp)
}

main().catch(e => { console.error(e); process.exit(1) })
