/**
 * Investigate the 56 (or so) USER_YES_MATCHER_NO leads — overrides
 * where the user asserted "this is on Monday" but the auto-matcher
 * finds no Monday entry anywhere.
 *
 * Hypothesis: Charisse (or others) is using the `not_relevant_leads`
 * Monday-board label as a "dismiss this lead" workflow instead of the
 * existing `is_not_relevant` flow. If true:
 *   - most/all 56 should be labeled `not_relevant_leads`
 *   - few of them should also have is_not_relevant=true
 *   - the domains shouldn't really be on Monday at all (they look like
 *     news/portal sites, not affiliate targets)
 *
 * What we cross-tab:
 *   - board distribution across the 56
 *   - is_not_relevant flag distribution
 *   - who set each override (via activity_log)
 *   - sample of domains so we can eyeball
 *
 * Read-only. No writes.
 *
 * Run: npx tsx scripts/qa/investigate-yes-matcher-no.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

type Lead = {
  id: number
  url: string | null
  domain: string | null
  is_on_monday: boolean | null
  monday_board: string | null
  monday_item_id: string | null
  monday_match_kind: string | null
  monday_overridden_at: string
  is_not_relevant: boolean
  not_relevant_marked_at: string | null
  not_relevant_marked_by: string | null
}

type Match = {
  board: string
  item_id: string
  item_name: string
  match_kind: string
}

type ActivityRow = {
  user_email: string | null
  details: { value?: string } | null
  created_at: string
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

async function fetchOverridden(svc: SupabaseClient): Promise<Lead[]> {
  const all: Lead[] = []
  let from = 0
  const pageSize = 1000
  for (;;) {
    const { data, error } = await svc
      .from('google_lead_gen_table')
      .select('id, url, domain, is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_overridden_at, is_not_relevant, not_relevant_marked_at, not_relevant_marked_by')
      .not('monday_overridden_at', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    const batch = (data ?? []) as Lead[]
    all.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }
  return all
}

async function getLatestOverrideAttribution(
  svc: SupabaseClient,
  leadId: number,
): Promise<{ who: string | null; value: string | null; when: string | null }> {
  const { data, error } = await svc
    .from('activity_log')
    .select('user_email, details, created_at')
    .eq('action', 'override.monday')
    .eq('entity_type', 'lead')
    .eq('entity_id', String(leadId))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    return { who: null, value: null, when: null }
  }
  const row = data as ActivityRow | null
  if (!row) return { who: null, value: null, when: null }
  return {
    who: row.user_email,
    value: row.details?.value ?? null,
    when: row.created_at,
  }
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

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const leads = await fetchOverridden(svc)

  // Filter to USER_YES_MATCHER_NO (matcher returns no hit, user says yes)
  console.log(`Re-running matcher on ${leads.length} overridden leads to identify USER_YES_MATCHER_NO…`)
  const enriched = await inBatches(leads, 25, async lead => {
    const match = await matchOne(svc, lead)
    return { lead, match }
  })
  const cluster = enriched.filter(r => r.match === null && r.lead.is_on_monday === true).map(r => r.lead)
  console.log(`Cluster size: ${cluster.length}\n`)

  // Attribution
  console.log('Pulling activity_log attribution for each lead…')
  const attributions = await inBatches(cluster, 10, async lead => {
    const attr = await getLatestOverrideAttribution(svc, lead.id)
    return { lead, attr }
  })

  // Distribution by board
  const boardCounts = new Map<string, number>()
  for (const { lead } of attributions) {
    const key = lead.monday_board ?? '(null)'
    boardCounts.set(key, (boardCounts.get(key) ?? 0) + 1)
  }
  console.log('\n=== Distribution by monday_board ===')
  for (const [k, v] of [...boardCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(35)} ${v}`)
  }

  // is_not_relevant cross-tab
  console.log('\n=== Cross-tab: monday_board × is_not_relevant ===')
  const xtab = new Map<string, { rel: number; notrel: number }>()
  for (const { lead } of attributions) {
    const key = lead.monday_board ?? '(null)'
    const slot = xtab.get(key) ?? { rel: 0, notrel: 0 }
    if (lead.is_not_relevant) slot.notrel++
    else slot.rel++
    xtab.set(key, slot)
  }
  console.log(`  ${'board'.padEnd(35)} ${'is_not_relevant=false'.padEnd(25)} is_not_relevant=true`)
  for (const [k, { rel, notrel }] of [...xtab.entries()].sort((a, b) => (b[1].rel + b[1].notrel) - (a[1].rel + a[1].notrel))) {
    console.log(`  ${k.padEnd(35)} ${String(rel).padEnd(25)} ${notrel}`)
  }

  // Attribution counts
  const whoCounts = new Map<string, number>()
  for (const { attr } of attributions) {
    const key = attr.who ?? '(unknown)'
    whoCounts.set(key, (whoCounts.get(key) ?? 0) + 1)
  }
  console.log('\n=== Who set the override (by user_email in activity_log) ===')
  for (const [k, v] of [...whoCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`)
  }

  // Sample domains per board
  console.log('\n=== Sample domains per board ===')
  for (const [board] of boardCounts) {
    const matching = attributions.filter(a => (a.lead.monday_board ?? '(null)') === board)
    console.log(`\n  ${board} (${matching.length} leads):`)
    for (const { lead, attr } of matching.slice(0, 8)) {
      const flagStr = lead.is_not_relevant ? ' [is_not_relevant=true]' : ''
      const whoStr = attr.who ? ` — by ${attr.who}` : ''
      console.log(`    #${lead.id}  ${lead.domain ?? lead.url}${flagStr}${whoStr}`)
    }
    if (matching.length > 8) console.log(`    … ${matching.length - 8} more`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
