import { config } from 'dotenv'; config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const ONCE = process.argv.includes('--once')
;(async()=>{
  const c = async ()=> (await s.from('google_lead_gen_table').select('id',{count:'exact',head:true}).eq('is_on_monday',true).is('monday_inherited_at',null)).count ?? 0
  const remainingStart = await c()
  console.log(`[monday-backfill] to process (on Monday, not yet inherited): ${remainingStart.toLocaleString()}`)
  let total = 0
  for (;;) {
    const { data, error } = await s.rpc('inherit_monday_data_batch', { p_limit: 100 })
    if (error) { console.error('batch error:', error.message); process.exit(1) }
    const n = (data as { processed?: number } | null)?.processed ?? 0
    total += n
    if (total % 1000 === 0 || n < 100) console.log(`  processed ${total} (batch ${n})`)
    if (n < 100) break
    if (ONCE) break
  }
  console.log(`\n✅ inherited ${total} leads from Monday. remaining now: ${(await c()).toLocaleString()}`)
})().catch(e=>{console.error(e);process.exit(1)})
