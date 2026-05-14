/**
 * Read-only sweep: for every lead with a Monday-label manual override,
 * compare what Charisse/anyone manually set vs what the current matcher
 * (`search_website_on_monday`) returns now. Categorize each row so we
 * can decide whether a bulk-clear of stale overrides is worth offering.
 *
 * Categories
 * ----------
 * REDUNDANT_POSITIVE   override says "yes/<board>"   AND matcher agrees (and on same board)
 * REDUNDANT_NEGATIVE   override says "no"            AND matcher returns no match
 * CONFLICT_USER_YES_MATCHER_NO   override says yes, matcher returns no match
 *                                  → manual override is still doing real work
 * CONFLICT_USER_NO_MATCHER_YES   override says no, but matcher would now match
 *                                  → user intentionally suppressed the auto-match
 * CONFLICT_BOARD_MISMATCH        both say yes, but disagree on which board / item
 *                                  → user manually picked a different board than matcher
 *
 * Read-only. No writes.
 *
 * Run: npx tsx scripts/qa/sweep-stale-overrides.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

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

type Category =
  | 'REDUNDANT_FULLY'              // user category + matcher fully agree (board + updates-flag)
  | 'REDUNDANT_BASE_BOARD'         // same base board, updates-flag differs (minor granularity loss if cleared)
  | 'REDUNDANT_NEGATIVE'           // user said "no", matcher returns no match
  | 'CONFLICT_USER_YES_MATCHER_NO' // user labeled some board, matcher returns nothing — override is doing real work
  | 'CONFLICT_USER_NO_MATCHER_YES' // user said "no", matcher would now match — user intentionally suppressed
  | 'CONFLICT_DIFFERENT_BOARD'    // both yes, disagree on which base board

// Map the user's 9 granular categories to {baseBoard, isUpdates}.
function splitUserBoard(board: string | null): { base: string | null; isUpdates: boolean } {
  if (!board) return { base: null, isUpdates: false }
  if (board.endsWith('_updates')) return { base: board.slice(0, -'_updates'.length), isUpdates: true }
  return { base: board, isUpdates: false }
}

function splitMatcherBoard(match: Match): { base: string; isUpdates: boolean } {
  return { base: match.board, isUpdates: match.match_kind === 'mentioned_in_updates' }
}

function classify(lead: OverriddenLead, match: Match | null): Category {
  const userSaysYes = lead.is_on_monday === true
  if (userSaysYes && match) {
    const u = splitUserBoard(lead.monday_board)
    const m = splitMatcherBoard(match)
    if (u.base === m.base) {
      return u.isUpdates === m.isUpdates ? 'REDUNDANT_FULLY' : 'REDUNDANT_BASE_BOARD'
    }
    return 'CONFLICT_DIFFERENT_BOARD'
  }
  if (userSaysYes && !match) return 'CONFLICT_USER_YES_MATCHER_NO'
  if (!userSaysYes && match) return 'CONFLICT_USER_NO_MATCHER_YES'
  return 'REDUNDANT_NEGATIVE'
}

async function fetchOverridden(svc: SupabaseClient, pageSize = 1000): Promise<OverriddenLead[]> {
  const all: OverriddenLead[] = []
  let from = 0
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
  // Normalize via RPC so we use the exact same logic the runner uses.
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
    if ((i / size) % 5 === 0 && i > 0) {
      process.stdout.write(`  …processed ${Math.min(i + size, items.length)}/${items.length}\r`)
    }
  }
  return out
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log('Fetching all leads with monday_overridden_at set…')
  const leads = await fetchOverridden(svc)
  console.log(`  ${leads.length} overridden leads.\n`)

  console.log('Running current matcher against each (parallelized, 25 at a time)…')
  type Row = { lead: OverriddenLead; match: Match | null; category: Category }
  const rows: Row[] = await inBatches(leads, 25, async lead => {
    const match = await matchOne(svc, lead)
    return { lead, match, category: classify(lead, match) }
  })
  console.log('') // clear the progress line

  // Category counts
  const counts: Record<Category, number> = {
    REDUNDANT_FULLY: 0,
    REDUNDANT_BASE_BOARD: 0,
    REDUNDANT_NEGATIVE: 0,
    CONFLICT_USER_YES_MATCHER_NO: 0,
    CONFLICT_USER_NO_MATCHER_YES: 0,
    CONFLICT_DIFFERENT_BOARD: 0,
  }
  for (const r of rows) counts[r.category]++

  const total = rows.length
  console.log('\n=== Categorization summary ===')
  for (const [cat, n] of Object.entries(counts)) {
    const pct = total === 0 ? 0 : Math.round((n / total) * 100)
    console.log(`  ${cat.padEnd(30)} ${String(n).padStart(5)}  (${pct}%)`)
  }
  console.log(`  ${'TOTAL'.padEnd(30)} ${String(total).padStart(5)}`)

  // Show a few examples per category for sanity
  const sample = (cat: Category, n = 5) => {
    const matching = rows.filter(r => r.category === cat).slice(0, n)
    if (matching.length === 0) return
    console.log(`\n--- Sample: ${cat} ---`)
    for (const r of matching) {
      const m = r.match
      console.log(`  lead #${r.lead.id}  ${r.lead.domain ?? r.lead.url}`)
      console.log(`    override: is_on_monday=${r.lead.is_on_monday}  board=${r.lead.monday_board ?? '—'}  item=${r.lead.monday_item_id ?? '—'}`)
      if (m) {
        console.log(`    matcher : board=${m.board}  item=${m.item_id}  kind=${m.match_kind}`)
      } else {
        console.log(`    matcher : (no match)`)
      }
    }
  }
  sample('REDUNDANT_FULLY')
  sample('REDUNDANT_BASE_BOARD')
  sample('REDUNDANT_NEGATIVE')
  sample('CONFLICT_USER_YES_MATCHER_NO')
  sample('CONFLICT_USER_NO_MATCHER_YES')
  sample('CONFLICT_DIFFERENT_BOARD')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
