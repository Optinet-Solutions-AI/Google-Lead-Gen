import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  // Sanity: does the RPC exist?
  const { data, error } = await s.rpc('claim_stag_render_batch', {
    p_worker_id: 'migration-verify',
    p_batch_size: 3,
  })
  console.log('RPC claim_stag_render_batch result:', JSON.stringify(data))
  if (error) console.log('  error:', error.message)
  // How many rows are eligible right now?
  const { count } = await s
    .from('fetched_html_cache')
    .select('lead_id', { count: 'exact', head: true })
    .not('render_completed_at', 'is', null)
  const { count: renderedAlready } = await s
    .from('fetched_html_cache')
    .select('lead_id', { count: 'exact', head: true })
    .eq('source', 'playwright_render')
  console.log(`\nfetched_html_cache stats:`)
  console.log(`  rows with render_completed_at set:  ${count ?? 0}`)
  console.log(`  rows with source=playwright_render: ${renderedAlready ?? 0}`)
  // Release the sample claim we just took so it doesn't sit for 10 min.
  const { data: released } = await s.rpc('release_stale_render_claims', { p_max_age_minutes: 0 })
  console.log(`\nReleased ${released ?? 0} claim(s) held by verify probe.`)
})().catch(e => { console.error(e); process.exit(1) })
