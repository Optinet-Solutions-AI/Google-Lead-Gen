/**
 * Verify the Push-to-Monday-Not-Relevant stamp fix (commit 6030b13).
 *
 * The bug: pushLeadToMondayNotRelevant created the Monday item fine, then
 * the local "stamp" UPDATE included `updated_at` — a column that does NOT
 * exist on google_lead_gen_table. PostgREST rejected the whole UPDATE with
 * "Could not find the 'updated_at' column ... in the schema cache", so the
 * lead never got hidden locally (Scenario A half-failed).
 *
 * This script proves both directions against the REAL table without
 * touching Monday at all (the create_item part already worked in prod):
 *   1. Replay the OLD payload (with updated_at)  -> expect schema-cache error
 *   2. Replay the FIXED payload (no updated_at)   -> expect success
 * It snapshots the chosen row first and RESTORES it exactly at the end, so
 * no real lead is left flagged.
 *
 * Run locally:  npx tsx scripts/qa/verify-not-relevant-stamp-fix.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const STAMP_COLS = [
  'id',
  'is_not_relevant',
  'not_relevant_marked_at',
  'not_relevant_marked_by',
  'is_on_monday',
  'monday_board',
  'monday_item_id',
  'monday_pushed_item_id',
  'monday_pushed_by',
  'pushed_to_monday_at',
] as const

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set (.env.local)')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  // Pick a fresh lead: not already not-relevant. We snapshot + restore, so
  // any row is safe, but a not-yet-flagged one mirrors the QA scenario.
  const { data: pick, error: pickErr } = await svc
    .from('google_lead_gen_table')
    .select(STAMP_COLS.join(','))
    .or('is_not_relevant.is.null,is_not_relevant.eq.false')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (pickErr) throw new Error(`pick failed: ${pickErr.message}`)
  if (!pick) throw new Error('No candidate lead found.')

  const snapshot = pick as Record<string, unknown>
  const leadId = snapshot.id as number
  console.log(`Using lead id=${leadId} as a throwaway test row (will restore after).\n`)

  const nowIso = new Date().toISOString()
  const fakeItemId = 'QA_VERIFY_DO_NOT_PUSH'

  const fixedPayload: Record<string, unknown> = {
    is_not_relevant: true,
    not_relevant_marked_at: nowIso,
    not_relevant_marked_by: 'qa-verify-script',
    is_on_monday: true,
    monday_board: 'not_relevant_leads',
    monday_item_id: fakeItemId,
    monday_pushed_item_id: fakeItemId,
    monday_pushed_by: 'qa-verify-script',
    pushed_to_monday_at: nowIso,
  }
  const oldPayload = { ...fixedPayload, updated_at: nowIso }

  // 1. OLD payload — should reproduce the schema-cache error.
  const { error: oldErr } = await svc
    .from('google_lead_gen_table')
    .update(oldPayload)
    .eq('id', leadId)
  if (oldErr) {
    console.log(`[1] OLD payload (with updated_at)  -> REJECTED as expected:`)
    console.log(`    ${oldErr.message}\n`)
  } else {
    console.log(`[1] OLD payload (with updated_at)  -> UNEXPECTEDLY succeeded`)
    console.log(`    (updated_at column may have been added since; bug context changed)\n`)
  }

  // 2. FIXED payload — should succeed.
  const { error: newErr } = await svc
    .from('google_lead_gen_table')
    .update(fixedPayload)
    .eq('id', leadId)
  if (newErr) {
    console.log(`[2] FIXED payload (no updated_at)  -> FAILED (fix is NOT working):`)
    console.log(`    ${newErr.message}\n`)
  } else {
    console.log(`[2] FIXED payload (no updated_at)  -> SUCCEEDED. Stamp applies cleanly.\n`)
  }

  // Restore the row to its original values exactly.
  const restore: Record<string, unknown> = {}
  for (const col of STAMP_COLS) {
    if (col === 'id') continue
    restore[col] = snapshot[col] ?? null
  }
  const { error: restErr } = await svc
    .from('google_lead_gen_table')
    .update(restore)
    .eq('id', leadId)
  if (restErr) {
    console.log(`!! RESTORE FAILED for lead ${leadId} — fix manually: ${restErr.message}`)
    console.log(`   original values:`, JSON.stringify(restore))
    process.exit(1)
  }
  console.log(`Restored lead ${leadId} to its original state.`)

  const ok = !!oldErr && !newErr
  console.log(`\nVERDICT: ${ok ? 'FIX CONFIRMED ✓' : 'INCONCLUSIVE — see output above'}`)
}

main().catch(e => { console.error(e); process.exit(1) })
