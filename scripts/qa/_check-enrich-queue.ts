import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const { count: pending } = await s
    .from('enrichment_fetch_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .contains('process_stages', ['stag'])
  const { count: running } = await s
    .from('enrichment_fetch_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'running')
    .contains('process_stages', ['stag'])
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
  const { count: completedRecent } = await s
    .from('enrichment_fetch_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed')
    .gte('completed_at', hourAgo)
  const { count: failedRecent } = await s
    .from('enrichment_fetch_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('completed_at', hourAgo)
  console.log(`stag pending: ${pending}`)
  console.log(`stag running: ${running}`)
  console.log(`stag completed (last 1h): ${completedRecent}`)
  console.log(`stag failed    (last 1h): ${failedRecent}`)

  // Any recently claimed?
  const { data: recent } = await s
    .from('enrichment_fetch_queue')
    .select('id, lead_id, url, status, claimed_by, started_at, completed_at')
    .contains('process_stages', ['stag'])
    .order('started_at', { ascending: false, nullsFirst: false })
    .limit(5)
  console.log('\nMost recently claimed/completed:')
  for (const r of (recent ?? []) as Array<Record<string, unknown>>) {
    console.log(`  ${r.status}  worker=${r.claimed_by ?? '-'}  started=${r.started_at ?? '-'}  url=${String(r.url).slice(0, 50)}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
