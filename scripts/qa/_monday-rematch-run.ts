/**
 * Re-match currently-not-on-Monday leads against the freshly-synced Monday
 * replica (respects manual monday_overridden_at — never touches operator
 * fixes), then inherit data for any that newly matched. Recent-first so the
 * leads behind fresh QA reports get fixed first.
 *
 * Small chunks: rematch_monday_for_leads runs the 6-tier website match +
 * S-tag tier per lead, which is heavy — 40/call stays under the statement
 * timeout; timeouts halve-and-retry.
 *   npx tsx scripts/qa/_monday-rematch-run.ts
 */
import { config } from 'dotenv'; config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const G = 'google_lead_gen_table'
const CHUNK = 40

async function rematch(ids: number[], attempt = 0): Promise<{ checked: number; flipped: number }> {
  const { data, error } = await s.rpc('rematch_monday_for_leads', { p_lead_ids: ids })
  if (error) {
    if (ids.length > 5 && attempt < 3) {
      const mid = Math.floor(ids.length / 2)
      const a = await rematch(ids.slice(0, mid), attempt + 1)
      const b = await rematch(ids.slice(mid), attempt + 1)
      return { checked: a.checked + b.checked, flipped: a.flipped + b.flipped }
    }
    console.error(`  ! chunk of ${ids.length} failed: ${error.message}`)
    return { checked: 0, flipped: 0 }
  }
  const row = Array.isArray(data) ? data[0] : data
  return { checked: row?.checked ?? ids.length, flipped: row?.flipped ?? 0 }
}

;(async () => {
  const ids: number[] = []
  let after = Number.MAX_SAFE_INTEGER
  for (;;) {
    // PostgREST caps rows per response (commonly 1000) regardless of a
    // larger .limit(), so page at 1000 and stop only on a short page.
    const PAGE = 1000
    const { data, error } = await s.from(G).select('id')
      .eq('is_on_monday', false).is('monday_overridden_at', null)
      .lt('id', after).order('id', { ascending: false }).limit(PAGE)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    for (const r of data as { id: number }[]) ids.push(r.id)
    after = (data[data.length - 1] as { id: number }).id
    if (data.length < PAGE) break
  }
  console.log(`[rematch] candidates: ${ids.length}`)

  let checked = 0, flipped = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await rematch(ids.slice(i, i + CHUNK))
    checked += r.checked; flipped += r.flipped
    if ((i / CHUNK) % 20 === 0 || i + CHUNK >= ids.length) {
      console.log(`  checked ${checked}/${ids.length} · flipped ${flipped}`)
    }
  }
  console.log(`\n✅ rematch: checked ${checked}, newly on-Monday: ${flipped}`)

  let inh = 0
  for (;;) {
    const { data, error } = await s.rpc('inherit_monday_data_batch', { p_limit: 200 })
    if (error) { console.error('inherit err:', error.message); break }
    const n = (data as { processed?: number } | null)?.processed ?? 0
    inh += n
    if (n < 200) break
  }
  console.log(`inherited data for ${inh} newly-matched leads.`)
})().catch(e => { console.error(e); process.exit(1) })
