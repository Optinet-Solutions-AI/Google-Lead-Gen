/**
 * Chunked rematch for the batch-1873 Monday-matcher fix.
 *
 * rematch_monday_for_all_leads(50000) times out on the full lateral join,
 * so drive backfill_monday_overridden_chunk(p_min, p_max) over the id
 * range in bounded slices. Run AFTER the 20260713120000 migration is live.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

interface ChunkResult {
  scanned: number
  flipped_on_monday: number
  flipped_not_relevant: number
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set (.env.local)')
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const { data: mx } = await svc.from('google_lead_gen_table').select('id').order('id', { ascending: false }).limit(1)
  const { data: mn } = await svc.from('google_lead_gen_table').select('id').order('id', { ascending: true }).limit(1)
  const maxId = (mx as Array<{ id: number }> | null)?.[0]?.id ?? 0
  const minId = (mn as Array<{ id: number }> | null)?.[0]?.id ?? 0
  console.log('id range', minId, '..', maxId)

  const STEP = 2000
  let scanned = 0, flipped = 0, nr = 0
  for (let lo = minId; lo <= maxId; lo += STEP) {
    const hi = lo + STEP - 1
    const { data, error } = await svc.rpc('backfill_monday_overridden_chunk', { p_min: lo, p_max: hi })
    if (error) { console.log('  ! chunk', lo, hi, error.message); continue }
    const r = (data as ChunkResult[] | null)?.[0] ?? { scanned: 0, flipped_on_monday: 0, flipped_not_relevant: 0 }
    scanned += r.scanned
    flipped += r.flipped_on_monday
    nr += r.flipped_not_relevant
    if (r.flipped_on_monday || r.flipped_not_relevant) console.log('  chunk', lo, hi, JSON.stringify(r))
  }
  console.log(`TOTAL scanned=${scanned} flipped_on_monday=${flipped} flipped_not_relevant=${nr}`)
}

main().catch(e => { console.error(e); process.exit(1) })
