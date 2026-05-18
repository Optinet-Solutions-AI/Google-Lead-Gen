/**
 * Cleanup: clear `monday_overridden_at` on leads where the current
 * matcher (`search_website_on_monday`) fully agrees with the existing
 * manual override — i.e., REDUNDANT_FULLY from sweep-stale-overrides.
 *
 * For each cleared lead we also write the matcher's full output (board,
 * item_id, match_kind) so the lead's Monday state stays the same — only
 * the "overridden_at" stamp is removed and match_kind is populated.
 *
 * Modes:
 *   default     dry-run; prints what would change
 *   --apply     actually runs the UPDATEs and writes audit-log entries
 *
 * REDUNDANT_BASE_BOARD cases (different updates-flag) are skipped — they
 * would lose user-set granularity and need a human call.
 *
 * Run:
 *   npx tsx scripts/qa/clear-redundant-overrides.ts            # dry-run
 *   npx tsx scripts/qa/clear-redundant-overrides.ts --apply    # commit
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const APPLY = process.argv.includes('--apply')

// Audit attribution — never write activity_log rows with a null operator.
// Honour OPERATOR_EMAIL if set; otherwise stamp the script path so log
// readers can see *which* CLI ran the cleanup.
const OPERATOR_EMAIL = (process.env.OPERATOR_EMAIL || '').trim() || 'cli:scripts/qa/clear-redundant-overrides.ts'

type OverriddenLead = {
  id: number
  url: string | null
  domain: string | null
  is_on_monday: boolean | null
  monday_board: string | null
  monday_item_id: string | null
  monday_match_kind: string | null
  monday_overridden_at: string
}

type Match = {
  board: string
  item_id: string
  item_name: string
  match_kind: string
}

function splitUserBoard(board: string | null): { base: string | null; isUpdates: boolean } {
  if (!board) return { base: null, isUpdates: false }
  if (board.endsWith('_updates')) return { base: board.slice(0, -'_updates'.length), isUpdates: true }
  return { base: board, isUpdates: false }
}

function splitMatcherBoard(match: Match): { base: string; isUpdates: boolean } {
  return { base: match.board, isUpdates: match.match_kind === 'mentioned_in_updates' }
}

function isRedundantFully(lead: OverriddenLead, match: Match | null): boolean {
  if (lead.is_on_monday !== true) return false
  if (!match) return false
  const u = splitUserBoard(lead.monday_board)
  const m = splitMatcherBoard(match)
  return u.base === m.base && u.isUpdates === m.isUpdates
}

async function fetchOverridden(svc: SupabaseClient): Promise<OverriddenLead[]> {
  const all: OverriddenLead[] = []
  let from = 0
  const pageSize = 1000
  for (;;) {
    const to = from + pageSize - 1
    const { data, error } = await svc
      .from('google_lead_gen_table')
      .select('id, url, domain, is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_overridden_at')
      .not('monday_overridden_at', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
    if (error) throw error
    const batch = (data ?? []) as OverriddenLead[]
    all.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }
  return all
}

async function matchOne(svc: SupabaseClient, lead: OverriddenLead): Promise<Match | null> {
  const probe = lead.domain ?? lead.url ?? ''
  if (!probe) return null
  const { data: normData, error: normErr } = await svc.rpc('normalize_domain', { p_input: probe })
  if (normErr) throw normErr
  const normalized = (normData as string | null) ?? ''
  if (!normalized) return null
  const { data, error } = await svc.rpc('search_website_on_monday', { p_domain: normalized })
  if (error) throw error
  const rows = (data as Match[]) ?? []
  return rows.length > 0 ? rows[0]! : null
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size)
    const results = await Promise.all(slice.map(fn))
    out.push(...results)
  }
  return out
}

type Action = {
  lead: OverriddenLead
  match: Match
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log(APPLY ? '*** APPLY MODE — will write to DB ***' : '*** DRY RUN — no writes ***')
  console.log('')

  const leads = await fetchOverridden(svc)
  console.log(`Found ${leads.length} overridden leads.`)

  const results = await inBatches(leads, 25, async lead => {
    const match = await matchOne(svc, lead)
    return { lead, match }
  })

  const actions: Action[] = results
    .filter((r): r is { lead: OverriddenLead; match: Match } => r.match !== null)
    .filter(r => isRedundantFully(r.lead, r.match))
    .map(r => ({ lead: r.lead, match: r.match }))

  console.log(`${actions.length} are REDUNDANT_FULLY and will be cleared.\n`)

  for (const a of actions) {
    console.log(`  #${a.lead.id}  ${a.lead.domain ?? a.lead.url}`)
    console.log(`    override: board=${a.lead.monday_board}  item=${a.lead.monday_item_id ?? '—'}  match_kind=${a.lead.monday_match_kind ?? '—'}`)
    console.log(`    matcher : board=${a.match.board}  item=${a.match.item_id}  match_kind=${a.match.match_kind}`)
  }

  if (!APPLY) {
    console.log(`\nDry run only — pass --apply to commit.`)
    return
  }

  if (actions.length === 0) {
    console.log('\nNothing to do.')
    return
  }

  console.log(`\nApplying updates…`)
  let success = 0
  let failed = 0
  for (const a of actions) {
    const patch = {
      is_on_monday: true,
      monday_board: a.match.board,
      monday_item_id: a.match.item_id,
      monday_match_kind: a.match.match_kind,
      monday_overridden_at: null,
    }
    const { error: updErr } = await svc
      .from('google_lead_gen_table')
      .update(patch)
      .eq('id', a.lead.id)
    if (updErr) {
      console.error(`  ! #${a.lead.id} update failed: ${updErr.message}`)
      failed++
      continue
    }

    // Audit log — record the *prior* override state so the action is
    // reversible from the log if needed.
    await svc.from('activity_log').insert({
      user_id: null,
      user_email: OPERATOR_EMAIL,
      action: 'monday.clear_stale_override',
      entity_type: 'lead',
      entity_id: String(a.lead.id),
      details: {
        source: 'scripts/qa/clear-redundant-overrides.ts',
        prior_override: {
          is_on_monday: a.lead.is_on_monday,
          monday_board: a.lead.monday_board,
          monday_item_id: a.lead.monday_item_id,
          monday_match_kind: a.lead.monday_match_kind,
          monday_overridden_at: a.lead.monday_overridden_at,
        },
        new_state: patch,
      },
    })
    success++
  }
  console.log(`\nDone. ${success} cleared, ${failed} failed.`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
