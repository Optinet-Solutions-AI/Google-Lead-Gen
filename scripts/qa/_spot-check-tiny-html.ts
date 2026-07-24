import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const { data } = await s
    .from('fetched_html_cache')
    .select('lead_id, url, html, fetched_at')
    .not('html', 'is', null)
    .order('fetched_at', { ascending: false })
    .limit(300)
  const rows = ((data ?? []) as Array<{ lead_id: number; url: string; html: string | null; fetched_at: string }>)
  const tiny = rows.filter(r => (r.html?.length ?? 0) < 500).slice(0, 5)
  console.log(`Tiny (<500B) cached HTML samples:`)
  for (const r of tiny) {
    console.log(`\nlead=${r.lead_id}  html_len=${r.html?.length}  fetched=${r.fetched_at}`)
    console.log(`  url: ${r.url}`)
    console.log(`  body: ${JSON.stringify(String(r.html ?? '').slice(0, 400))}`)
  }
  console.log(`\nTotal tiny in this 300-row sample: ${tiny.length}`)
})().catch(e => { console.error(e); process.exit(1) })
