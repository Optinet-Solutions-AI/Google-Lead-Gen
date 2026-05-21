/**
 * Drives the chunked backfill for 20260522060001 — calls
 * `backfill_monday_overridden_chunk(p_min, p_max)` over the full lead
 * id range, then cancels any pending/paused enrichment for leads that
 * just flipped to is_not_relevant=true.
 *
 * Idempotent. Safe to re-run.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const CHUNK = 500

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: maxRow, error: maxErr } = await svc
    .from('google_lead_gen_table')
    .select('id')
    .order('id', { ascending: false })
    .limit(1)
  if (maxErr) throw maxErr
  const maxId: number = (maxRow as Array<{ id: number }> | null)?.[0]?.id ?? 0
  if (!maxId) { console.log('Empty table.'); return }
  console.log(`Backfilling ids 1..${maxId} in chunks of ${CHUNK}…`)

  let totalScanned = 0, totalFlipped = 0, totalNr = 0
  for (let lo = 1; lo <= maxId; lo += CHUNK) {
    const hi = lo + CHUNK - 1
    const t0 = Date.now()
    const { data, error } = await svc.rpc('backfill_monday_overridden_chunk', { p_min: lo, p_max: hi })
    if (error) { console.error(`  ! ${lo}-${hi}: ${error.message}`); throw error }
    const row = (data as Array<{ scanned: number; flipped_on_monday: number; flipped_not_relevant: number }> | null)?.[0]
    const scanned = row?.scanned ?? 0
    const flipped = row?.flipped_on_monday ?? 0
    const nr = row?.flipped_not_relevant ?? 0
    totalScanned += scanned
    totalFlipped += flipped
    totalNr += nr
    console.log(`  ${String(lo).padStart(6)}-${String(hi).padStart(6)}  scanned=${String(scanned).padStart(5)}  flipped=${String(flipped).padStart(4)}  → not_relevant=${String(nr).padStart(3)}  (${Date.now() - t0}ms)`)
  }
  console.log(`\nBackfill totals: scanned=${totalScanned}  flipped=${totalFlipped}  → not_relevant=${totalNr}`)

  console.log('\nCancelling pending/paused enrichment for leads now is_not_relevant=true…')
  // Pull the affected lead ids, then cancel in batches via supabase-js.
  let lastId = 0
  let cancelled = 0
  while (true) {
    const { data: leads, error: leadsErr } = await svc
      .from('google_lead_gen_table')
      .select('id')
      .eq('is_not_relevant', true)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(1000)
    if (leadsErr) throw leadsErr
    const rows = (leads as Array<{ id: number }> | null) ?? []
    if (rows.length === 0) break
    const ids = rows.map(r => r.id)
    const { error: cancelErr, count } = await svc
      .from('enrichment_fetch_queue')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() }, { count: 'exact' })
      .in('lead_id', ids)
      .in('status', ['pending', 'paused'])
    if (cancelErr) throw cancelErr
    cancelled += count ?? 0
    lastId = ids[ids.length - 1]!
    if (rows.length < 1000) break
  }
  console.log(`Cancelled enrichment rows: ${cancelled}`)
}

main().catch(e => { console.error(e); process.exit(1) })
