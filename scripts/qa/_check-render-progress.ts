import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

;(async () => {
  // Currently claimed (workers actively rendering)
  const { data: claimed } = await s
    .from('fetched_html_cache')
    .select('lead_id, url, render_claimed_by, render_claimed_at')
    .not('render_claimed_by', 'is', null)
    .is('render_completed_at', null)
    .order('render_claimed_at', { ascending: false })
    .limit(20)
  console.log(`=== Currently claimed (rendering right now): ${(claimed ?? []).length} ===`)
  for (const r of ((claimed ?? []) as Array<Record<string, unknown>>)) {
    console.log(`  ${r.render_claimed_by}  ${String(r.url).slice(0, 60)}  since ${r.render_claimed_at}`)
  }

  // Completed by render worker
  const { count: totalCompleted } = await s
    .from('fetched_html_cache')
    .select('lead_id', { count: 'exact', head: true })
    .eq('source', 'playwright_render')
  console.log(`\n=== Total lifetime rendered (source='playwright_render'): ${totalCompleted ?? 0} ===`)

  // Recent completions
  const { data: recent } = await s
    .from('fetched_html_cache')
    .select('lead_id, url, render_claimed_by, render_completed_at, html_length, fetch_error')
    .eq('source', 'playwright_render')
    .order('render_completed_at', { ascending: false, nullsFirst: false })
    .limit(15)
  console.log(`\n=== Most recent renders (top 15) ===`)
  for (const r of ((recent ?? []) as Array<Record<string, unknown>>)) {
    const errStr = r.fetch_error ? `  ERR: ${String(r.fetch_error).slice(0, 40)}` : ''
    console.log(`  ${r.render_claimed_by ?? '?'}  html_len=${String(r.html_length).padStart(6)}  ${r.render_completed_at}${errStr}`)
    console.log(`    ${String(r.url).slice(0, 90)}`)
  }

  // Remaining backlog
  const { count: backlog } = await s
    .from('fetched_html_cache')
    .select('lead_id', { count: 'exact', head: true })
    .lt('html_length', 500)
    .is('render_claimed_by', null)
    .or('source.is.null,source.neq.playwright_render')
  console.log(`\n=== Remaining backlog (unclaimed + FETCH_EMPTY + not yet rendered): ${backlog ?? 0} ===`)
})().catch(e => { console.error(e); process.exit(1) })
