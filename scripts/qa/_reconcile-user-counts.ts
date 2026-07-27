import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

// Window the user is looking at: 1 Jul → 27 Jul (inclusive), UTC.
const SINCE = '2026-07-01T00:00:00.000Z'
const UNTIL = '2026-07-27T23:59:59.999Z'

;(async () => {
  for (const needle of ['andrei', 'darren']) {
    // Pull all rows for this user in the window (match by email prefix).
    const { data } = await s
      .from('scrape_queue')
      .select('id, created_by_email, created_at, status, parent_scrape_job_id, search_engine')
      .gte('created_at', SINCE)
      .lte('created_at', UNTIL)
      .ilike('created_by_email', `${needle}%`)
      .limit(20000)
    const rows = (data ?? []) as Array<{
      status: string
      parent_scrape_job_id: string | null
      search_engine: string | null
    }>
    const all = rows.length
    const phase1 = rows.filter(r => r.parent_scrape_job_id === null).length
    const phase2 = all - phase1
    console.log(`\n=== ${needle} · 1 Jul → 27 Jul ===`)
    console.log(`  ALL rows (per-user cap counts these):        ${all}`)
    console.log(`  phase-1 only (compare tool counts these):    ${phase1}`)
    console.log(`  phase-2 children (fan-out, excluded by compare): ${phase2}`)
    // Engine split of phase-2 (which engines fan out into children)
    const byEngine: Record<string, number> = {}
    for (const r of rows) {
      if (r.parent_scrape_job_id !== null) {
        const e = r.search_engine ?? '?'
        byEngine[e] = (byEngine[e] ?? 0) + 1
      }
    }
    if (phase2 > 0) console.log(`  phase-2 by engine: ${JSON.stringify(byEngine)}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
