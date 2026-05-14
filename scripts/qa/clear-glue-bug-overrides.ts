/**
 * Targeted cleanup: clear monday_overridden_at on the 5 specific leads
 * that the glue-bug migration unblocked. For each one the current
 * matcher returns `mentioned_in_updates` on item 2539285865 — strictly
 * more specific than the existing override (which had match_kind=null),
 * so stamping the matcher's result is an info upgrade, not a loss.
 *
 * clear-redundant-overrides.ts deliberately skips REDUNDANT_BASE_BOARD
 * cases to avoid losing user-set granularity. That guard doesn't apply
 * here because the user's overrides have no granularity (match_kind is
 * null on all 5). Kept as a separate one-off script so the generic
 * one stays conservative.
 *
 * Modes:
 *   default   dry-run; prints what would change
 *   --apply   actually run UPDATEs and audit-log entries
 *
 * Run:
 *   npx tsx scripts/qa/clear-glue-bug-overrides.ts
 *   npx tsx scripts/qa/clear-glue-bug-overrides.ts --apply
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const LEAD_IDS = [757, 769, 770, 782, 789]
const APPLY = process.argv.includes('--apply')

type Lead = {
  id: number
  url: string | null
  domain: string | null
  is_on_monday: boolean | null
  monday_board: string | null
  monday_item_id: string | null
  monday_match_kind: string | null
  monday_overridden_at: string | null
}

type Match = {
  board: string
  item_id: string
  item_name: string
  match_kind: string
}

async function matchOne(svc: SupabaseClient, lead: Lead): Promise<Match | null> {
  const probe = lead.domain ?? lead.url ?? ''
  if (!probe) return null
  const { data: normData } = await svc.rpc('normalize_domain', { p_input: probe })
  const normalized = (normData as string | null) ?? ''
  if (!normalized) return null
  const { data } = await svc.rpc('search_website_on_monday', { p_domain: normalized })
  const rows = (data as Match[]) ?? []
  return rows.length > 0 ? rows[0]! : null
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`Targets: ${LEAD_IDS.join(', ')}\n`)

  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_overridden_at')
    .in('id', LEAD_IDS)
  if (error) throw error
  const leads = (data ?? []) as Lead[]

  let success = 0
  let skipped = 0
  let failed = 0

  for (const lead of leads) {
    console.log(`--- lead #${lead.id}  ${lead.domain ?? lead.url} ---`)
    console.log(`  override: is_on_monday=${lead.is_on_monday}  board=${lead.monday_board}  item=${lead.monday_item_id ?? '—'}  match_kind=${lead.monday_match_kind ?? '—'}`)

    if (!lead.monday_overridden_at) {
      console.log('  ! not overridden — skipping')
      skipped++
      continue
    }
    if (lead.monday_match_kind !== null) {
      console.log(`  ! match_kind is "${lead.monday_match_kind}" not null — refusing to overwrite. Skip.`)
      skipped++
      continue
    }

    const match = await matchOne(svc, lead)
    if (!match) {
      console.log('  ! matcher returns no match — would CONFLICT, skip')
      skipped++
      continue
    }
    console.log(`  matcher : board=${match.board}  item=${match.item_id}  kind=${match.match_kind}`)

    if (match.board !== lead.monday_board) {
      console.log(`  ! matcher board differs from override board — skip`)
      skipped++
      continue
    }

    if (!APPLY) {
      console.log('  would clear override + stamp matcher result')
      continue
    }

    const patch = {
      is_on_monday: true,
      monday_board: match.board,
      monday_item_id: match.item_id,
      monday_match_kind: match.match_kind,
      monday_overridden_at: null,
    }
    const { error: updErr } = await svc
      .from('google_lead_gen_table')
      .update(patch)
      .eq('id', lead.id)
    if (updErr) {
      console.log(`  ✗ update failed: ${updErr.message}`)
      failed++
      continue
    }

    await svc.from('activity_log').insert({
      user_id: null,
      user_email: null,
      action: 'monday.clear_stale_override',
      entity_type: 'lead',
      entity_id: String(lead.id),
      details: {
        source: 'scripts/qa/clear-glue-bug-overrides.ts',
        reason: 'glue-bug migration unblocked the matcher; user override had no granularity to preserve',
        prior_override: {
          is_on_monday: lead.is_on_monday,
          monday_board: lead.monday_board,
          monday_item_id: lead.monday_item_id,
          monday_match_kind: lead.monday_match_kind,
          monday_overridden_at: lead.monday_overridden_at,
        },
        new_state: patch,
      },
    })

    console.log(`  ✓ cleared`)
    success++
  }

  console.log(`\nDone. ${success} cleared, ${skipped} skipped, ${failed} failed.`)
  if (!APPLY) console.log('\nDry-run only. Re-run with --apply to commit.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
