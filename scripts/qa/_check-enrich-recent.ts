import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const { data } = await s.from('enrichment_fetch_queue').select('id, status, process_stages, created_at, claimed_by').order('created_at', { ascending: false }).limit(10)
  console.log('recent enrichment_fetch_queue rows:')
  for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
    console.log(`  id=${r.id}  status=${r.status}  stages=${JSON.stringify(r.process_stages)}  worker=${r.claimed_by ?? '-'}  created=${r.created_at}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
