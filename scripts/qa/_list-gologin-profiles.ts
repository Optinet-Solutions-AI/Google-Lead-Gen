import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const { data } = await s
    .from('gologin_profiles')
    .select('country_code, country_name, gologin_profile_id, is_active')
    .eq('is_active', true)
    .not('gologin_profile_id', 'is', null)
    .order('country_code')
  console.log('Active GoLogin profiles:')
  console.log(`${'Country'.padEnd(4)}  Name`.padEnd(30) + '  Profile ID')
  for (const p of (data ?? []) as Array<{ country_code: string; country_name: string | null; gologin_profile_id: string }>) {
    console.log(`  ${p.country_code.padEnd(4)}  ${(p.country_name ?? '').padEnd(22)}  ${p.gologin_profile_id}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
