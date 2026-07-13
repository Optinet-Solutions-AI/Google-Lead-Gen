/**
 * Run AFTER pasting 20260713120000_monday_match_restore_name_and_updates_tiers.sql
 * into the Supabase SQL editor.
 *
 *   1. Re-probes Supriya's two domains — both should now hit.
 *   2. Re-runs rematch_monday_for_all_leads so existing leads flip
 *      from "No" to their true board.
 *
 * Read-only until step 2 (which only updates non-overridden leads via
 * the canonical rematch RPC the nightly sync already uses).
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set (.env.local)')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('=== 1. Re-probe the two reported domains ===')
  for (const d of ['esportsinsider.com', 'casibella.com']) {
    const { data, error } = await svc.rpc('search_website_on_monday', { p_domain: d })
    if (error) { console.log(`  ! ${d}: ${error.message}`); continue }
    const hits = (data ?? []) as Array<{ board: string; item_id: string; item_name: string; match_kind: string }>
    console.log(`  ${d} → ${hits.length} hit(s)`)
    for (const m of hits) console.log(`     ✓ ${m.board} / ${m.item_id} / "${m.item_name}" — ${m.match_kind}`)
    if (hits.length === 0) console.log('     ✗ STILL 0 — migration not applied yet?')
  }

  console.log('\n=== 2. Rematch all non-overridden leads ===')
  const { data, error } = await svc.rpc('rematch_monday_for_all_leads', { p_limit: 50_000 })
  if (error) { console.log(`  ! rematch failed: ${error.message}`); process.exit(1) }
  console.log(`  rematch done: ${JSON.stringify(data)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
