import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const now = Date.now()
  const bounds = [
    { label: 'last 2 min',  since: new Date(now - 2 * 60_000).toISOString(), scale: 30 },
    { label: 'last 5 min',  since: new Date(now - 5 * 60_000).toISOString(), scale: 12 },
    { label: 'last 15 min', since: new Date(now - 15 * 60_000).toISOString(), scale: 4 },
  ]
  console.log('Render throughput:')
  for (const b of bounds) {
    const { count: ok } = await s
      .from('fetched_html_cache')
      .select('lead_id', { count: 'exact', head: true })
      .eq('source', 'playwright_render')
      .is('fetch_error', null)
      .gte('render_completed_at', b.since)
    const { count: err } = await s
      .from('fetched_html_cache')
      .select('lead_id', { count: 'exact', head: true })
      .eq('source', 'playwright_render')
      .not('fetch_error', 'is', null)
      .gte('render_completed_at', b.since)
    const total = (ok ?? 0) + (err ?? 0)
    console.log(`  ${b.label.padEnd(12)}: ${String(total).padStart(4)} total  (ok=${ok ?? 0}, err=${err ?? 0})  → ~${(total * b.scale).toLocaleString()}/hr projected`)
  }

  const { count: totalDone } = await s
    .from('fetched_html_cache')
    .select('lead_id', { count: 'exact', head: true })
    .eq('source', 'playwright_render')
  const { count: backlog } = await s
    .from('fetched_html_cache')
    .select('lead_id', { count: 'exact', head: true })
    .lt('html_length', 500)
    .is('render_claimed_by', null)
    .or('source.is.null,source.neq.playwright_render')
  console.log(`\nTotal rendered lifetime: ${totalDone ?? 0}`)
  console.log(`Backlog remaining:       ${backlog ?? 0}`)
})().catch(e => { console.error(e); process.exit(1) })
