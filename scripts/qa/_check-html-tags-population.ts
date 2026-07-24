import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

;(async () => {
  console.log('=== html_tags population on SUCCESSFUL extractions ===')
  const { data: successful } = await s
    .from('google_lead_gen_table')
    .select('id, url, has_s_tags, html_tags')
    .eq('has_s_tags', true)
    .order('id', { ascending: false })
    .limit(20)
  for (const r of ((successful ?? []) as Array<{ id: number; url: string | null; has_s_tags: boolean; html_tags: unknown }>)) {
    const h = r.html_tags as null | { a?: string[]; meta?: string[]; script?: string[] }
    const a = h?.a?.length ?? 0
    const meta = h?.meta?.length ?? 0
    const script = h?.script?.length ?? 0
    console.log(`  lead ${r.id}  a=${String(a).padStart(3)}  meta=${String(meta).padStart(2)}  script=${String(script).padStart(2)}  url=${String(r.url).slice(0, 60)}`)
  }

  console.log('\n=== html_tags population on FAILED extractions (is_affiliate=true, has_s_tags=false) ===')
  const { data: failed } = await s
    .from('google_lead_gen_table')
    .select('id, url, has_s_tags, html_tags')
    .eq('is_affiliate', true)
    .eq('has_s_tags', false)
    .order('id', { ascending: false })
    .limit(20)
  for (const r of ((failed ?? []) as Array<{ id: number; url: string | null; has_s_tags: boolean; html_tags: unknown }>)) {
    const h = r.html_tags as null | { a?: string[]; meta?: string[]; script?: string[] }
    const a = h?.a?.length ?? 0
    const meta = h?.meta?.length ?? 0
    const script = h?.script?.length ?? 0
    console.log(`  lead ${r.id}  a=${String(a).padStart(3)}  meta=${String(meta).padStart(2)}  script=${String(script).padStart(2)}  url=${String(r.url).slice(0, 60)}`)
  }

  // Overall stats: what % of leads have empty html_tags?
  console.log('\n=== Aggregate: how often is html_tags empty? ===')
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: all } = await s
    .from('google_lead_gen_table')
    .select('id, has_s_tags, html_tags')
    .eq('is_affiliate', true)
    .gte('s_tags_checked_at', since)
    .limit(2000)
  let total = 0, empty = 0, nonempty = 0, nullTags = 0
  let emptyAndFailed = 0, emptyAndSuccess = 0, nonemptyAndFailed = 0, nonemptyAndSuccess = 0
  for (const r of ((all ?? []) as Array<{ id: number; has_s_tags: boolean | null; html_tags: unknown }>)) {
    total++
    const h = r.html_tags as null | { a?: string[]; meta?: string[]; script?: string[] }
    if (h === null) { nullTags++; continue }
    const anyTags = (h?.a?.length ?? 0) + (h?.meta?.length ?? 0) + (h?.script?.length ?? 0)
    if (anyTags === 0) {
      empty++
      if (r.has_s_tags) emptyAndSuccess++
      else emptyAndFailed++
    } else {
      nonempty++
      if (r.has_s_tags) nonemptyAndSuccess++
      else nonemptyAndFailed++
    }
  }
  console.log(`  total sampled:  ${total}`)
  console.log(`  html_tags NULL: ${nullTags}`)
  console.log(`  html_tags EMPTY (all counters 0): ${empty}  (${((empty / total) * 100).toFixed(1)}%)`)
  console.log(`    of which s_tag extracted: ${emptyAndSuccess}`)
  console.log(`    of which s_tag missing:   ${emptyAndFailed}`)
  console.log(`  html_tags POPULATED: ${nonempty}  (${((nonempty / total) * 100).toFixed(1)}%)`)
  console.log(`    of which s_tag extracted: ${nonemptyAndSuccess}`)
  console.log(`    of which s_tag missing:   ${nonemptyAndFailed}`)
  console.log(`\n  KEY: if 'empty & failed' is the biggest bucket, the primary win is fixing HTML FETCH not fixing EXTRACTION.`)
})().catch(e => { console.error(e); process.exit(1) })
