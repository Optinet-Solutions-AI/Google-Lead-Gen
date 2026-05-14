/**
 * Diagnose Monday false-negatives lead-by-lead.
 *
 * For each lead ID passed (or the default set of Charisse's 6 QA-reported
 * leads if none given), pull:
 *   - the lead's URL, domain, normalized form, registered (eTLD+1)
 *   - the current is_on_monday / monday_board / monday_match_kind
 *   - what search_website_on_monday() returns *now*
 *   - candidate matches across the 4 Monday board tables (exact +
 *     registered + body_domain mention) so we can see what *should* match
 *
 * Run:
 *   npx tsx scripts/qa/diagnose-monday-misses.ts             # Charisse's 6
 *   npx tsx scripts/qa/diagnose-monday-misses.ts 680 757 769 # any IDs
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const DEFAULT_LEADS = [8766, 8689, 8603, 8594, 8606, 5764]
const argIds = process.argv.slice(2).map(s => Number.parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0)
const FLAGGED_LEADS = argIds.length > 0 ? argIds : DEFAULT_LEADS

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

const BOARD_TABLES = [
  'leads_table',
  'affiliates_table',
  'not_relevant_leads_table',
  'email_undelivered_leads_table',
] as const

const UPDATE_TABLES = [
  'leads_updates_table',
  'affiliates_updates_table',
  'not_relevant_leads_updates_table',
  'email_undelivered_leads_updates_table',
] as const

async function rpcNormalize(svc: SupabaseClient, raw: string): Promise<string> {
  const { data, error } = await svc.rpc('normalize_domain', { p_input: raw })
  if (error) throw error
  return (data as string | null) ?? ''
}

async function rpcRegistered(svc: SupabaseClient, normalized: string): Promise<string> {
  const { data, error } = await svc.rpc('registered_domain', { p_normalized: normalized })
  if (error) throw error
  return (data as string | null) ?? ''
}

async function search(svc: SupabaseClient, domain: string): Promise<Match[]> {
  const { data, error } = await svc.rpc('search_website_on_monday', { p_domain: domain })
  if (error) throw error
  return (data as Match[]) ?? []
}

async function findCandidatesByExactOrRegistered(
  svc: SupabaseClient,
  normalized: string,
  registered: string,
): Promise<Array<{ board: string; item_id: string; name: string; website: string; website_normalized: string }>> {
  const candidates: Array<{ board: string; item_id: string; name: string; website: string; website_normalized: string }> = []
  for (const table of BOARD_TABLES) {
    // Find any row whose website_normalized contains parts of our domain
    // or vice versa. Broader than the canonical matcher.
    const { data, error } = await svc
      .from(table)
      .select('monday_item_id, name, website, website_normalized')
      .or(`website_normalized.eq.${normalized},website_normalized.eq.${registered},website_normalized.ilike.%${registered}%`)
      .limit(20)
    if (error) {
      console.warn(`  ! ${table} query error: ${error.message}`)
      continue
    }
    for (const row of (data ?? []) as Array<{ monday_item_id: string; name: string; website: string; website_normalized: string }>) {
      candidates.push({
        board: table.replace('_table', ''),
        item_id: row.monday_item_id,
        name: row.name,
        website: row.website,
        website_normalized: row.website_normalized,
      })
    }
  }
  return candidates
}

async function findUpdateMentions(
  svc: SupabaseClient,
  registered: string,
): Promise<Array<{ table: string; monday_item_id: string; body_text_snippet: string; body_domains: string[] }>> {
  const hits: Array<{ table: string; monday_item_id: string; body_text_snippet: string; body_domains: string[] }> = []
  for (const table of UPDATE_TABLES) {
    // Body-domain array containment (the actual indexed strategy)
    const { data: byArray } = await svc
      .from(table)
      .select('monday_item_id, body_text, body_domains')
      .contains('body_domains', [registered])
      .limit(5)

    // Also: plain ILIKE on body_text — catches cases where extract_normalized_domains
    // missed the URL (e.g., weird formatting, glued together, etc.)
    const { data: byText } = await svc
      .from(table)
      .select('monday_item_id, body_text, body_domains')
      .ilike('body_text', `%${registered}%`)
      .limit(5)

    const seen = new Set<string>()
    for (const r of (byArray ?? []) as Array<{ monday_item_id: string; body_text: string; body_domains: string[] }>) {
      const key = `${r.monday_item_id}-${r.body_text?.slice(0, 60)}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({
        table,
        monday_item_id: r.monday_item_id,
        body_text_snippet: (r.body_text ?? '').slice(0, 200),
        body_domains: r.body_domains,
      })
    }
    for (const r of (byText ?? []) as Array<{ monday_item_id: string; body_text: string; body_domains: string[] }>) {
      const key = `${r.monday_item_id}-${r.body_text?.slice(0, 60)}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({
        table: table + ' (text-only)',
        monday_item_id: r.monday_item_id,
        body_text_snippet: (r.body_text ?? '').slice(0, 200),
        body_domains: r.body_domains,
      })
    }
  }
  return hits
}

async function diagnose(svc: SupabaseClient, leadId: number) {
  console.log(`\n${'='.repeat(70)}\nLead #${leadId}`)
  const { data: leadData, error } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_overridden_at')
    .eq('id', leadId)
    .maybeSingle()
  if (error) throw error
  const lead = leadData as Lead | null
  if (!lead) {
    console.log('  Not found.')
    return
  }
  console.log(`  URL:           ${lead.url ?? '(none)'}`)
  console.log(`  domain field:  ${lead.domain ?? '(none)'}`)

  const inputForNormalize = lead.domain ?? lead.url ?? ''
  const normalized = await rpcNormalize(svc, inputForNormalize)
  const registered = await rpcRegistered(svc, normalized)
  console.log(`  normalized:    ${normalized}`)
  console.log(`  registered:    ${registered}`)
  console.log(`  CURRENT state: is_on_monday=${lead.is_on_monday}  board=${lead.monday_board}  match_kind=${lead.monday_match_kind}  item=${lead.monday_item_id}`)
  console.log(`  overridden_at: ${lead.monday_overridden_at ?? '(no — auto)'}`)

  // 1. Run the canonical matcher
  const matches = await search(svc, normalized)
  console.log(`  search_website_on_monday() → ${matches.length === 0 ? '(no match)' : ''}`)
  for (const m of matches) {
    console.log(`    ✓ ${m.board} / ${m.item_id} / "${m.item_name}" — ${m.match_kind}`)
  }

  // 2. Broader candidate scan to find what *should* have matched
  const candidates = await findCandidatesByExactOrRegistered(svc, normalized, registered)
  if (candidates.length > 0) {
    console.log(`  Candidate exact/registered/ILIKE rows on Monday boards:`)
    for (const c of candidates) {
      console.log(`    • ${c.board} / ${c.item_id} / "${c.name}"`)
      console.log(`        website='${c.website}'  normalized='${c.website_normalized}'`)
    }
  }

  // 3. Mentions in board updates
  const mentions = await findUpdateMentions(svc, registered)
  if (mentions.length > 0) {
    console.log(`  Mentions in updates tables:`)
    for (const u of mentions) {
      console.log(`    • ${u.table} on item ${u.monday_item_id}`)
      console.log(`        body_domains: [${u.body_domains?.slice(0, 6).join(', ') ?? ''}${(u.body_domains?.length ?? 0) > 6 ? ', …' : ''}]`)
      console.log(`        body_text: "${u.body_text_snippet.replace(/\s+/g, ' ').trim()}…"`)
    }
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  for (const id of FLAGGED_LEADS) {
    try {
      await diagnose(svc, id)
    } catch (e) {
      console.error(`Error diagnosing lead ${id}:`, e)
    }
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
