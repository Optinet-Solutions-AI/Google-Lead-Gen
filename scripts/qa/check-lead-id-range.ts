import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: minRow } = await svc.from('google_lead_gen_table').select('id').is('monday_overridden_at', null).order('id', { ascending: true }).limit(1)
  const { data: maxRow } = await svc.from('google_lead_gen_table').select('id').is('monday_overridden_at', null).order('id', { ascending: false }).limit(1)
  const { count } = await svc.from('google_lead_gen_table').select('id', { head: true, count: 'exact' }).is('monday_overridden_at', null)
  console.log(`min=${minRow?.[0]?.id} max=${maxRow?.[0]?.id} count=${count}`)
}
main().catch(e => { console.error(e); process.exit(1) })
