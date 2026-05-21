/**
 * Compare what Monday actually has for "casinoohneoasis.com" with
 * what our Supabase replica + matcher see.
 *
 * Monday screenshot (manual check) shows 5 cross-board items:
 *   Leads:
 *     - de.trustpilot.com/review/casinolounge...
 *     - de.trustpilot.com/review/ohneoasis.de
 *     - onlinecasinoohneoasis.com
 *     - onlinecasinoohneoasis.de.com
 *   Affiliates: (1, not visible in shot)
 *
 * Our matcher returned no match. We want to know which of those 5
 * are actually in our replica, on which columns, and why our
 * search_website_on_monday() doesn't surface them.
 *
 * Read-only.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const TABLES = [
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

const SEARCH_STRINGS = [
  'casinoohneoasis',
  'ohneoasis.de',
  'trustpilot.com/review/casinolounge',
  'trustpilot.com/review/ohneoasis',
  'onlinecasinoohneoasis',
]

async function dumpBoardHits(svc: SupabaseClient) {
  for (const table of TABLES) {
    for (const needle of SEARCH_STRINGS) {
      const { data, error } = await svc
        .from(table)
        .select('monday_item_id, name, website, website_normalized')
        .or(`name.ilike.%${needle}%,website.ilike.%${needle}%,website_normalized.ilike.%${needle}%`)
        .limit(10)
      if (error) { console.warn(`  ! ${table}/${needle}: ${error.message}`); continue }
      if ((data ?? []).length === 0) continue
      console.log(`\n--- ${table}  needle=${needle}  (${data!.length}) ---`)
      for (const r of data as Array<{ monday_item_id: string; name: string; website: string | null; website_normalized: string | null }>) {
        console.log(`  item=${r.monday_item_id}  name="${r.name}"  website="${r.website}"  normalized="${r.website_normalized}"`)
      }
    }
  }
}

async function dumpUpdateHits(svc: SupabaseClient) {
  for (const table of UPDATE_TABLES) {
    const { data, error } = await svc
      .from(table)
      .select('monday_item_id, body_text, body_domains')
      .ilike('body_text', `%casinoohneoasis%`)
      .limit(20)
    if (error) { console.warn(`  ! ${table}: ${error.message}`); continue }
    if ((data ?? []).length === 0) continue
    console.log(`\n--- ${table}  ILIKE casinoohneoasis  (${data!.length}) ---`)
    for (const r of data as Array<{ monday_item_id: string; body_text: string | null; body_domains: string[] | null }>) {
      console.log(`  item=${r.monday_item_id}`)
      console.log(`    body_domains=${JSON.stringify(r.body_domains)}`)
      console.log(`    body_text="${(r.body_text ?? '').replace(/\s+/g, ' ').slice(0, 400)}"`)
    }
  }
}

// Also try body_domains array containment for the registered domain itself.
async function dumpBodyDomainsContains(svc: SupabaseClient) {
  for (const table of UPDATE_TABLES) {
    for (const needle of ['casinoohneoasis.com', 'casinoohneoasis.de.com', 'casinoohneoasis.com.de']) {
      const { data, error } = await svc
        .from(table)
        .select('monday_item_id, body_text, body_domains')
        .contains('body_domains', [needle])
        .limit(10)
      if (error) { console.warn(`  ! ${table}/${needle}: ${error.message}`); continue }
      if ((data ?? []).length === 0) continue
      console.log(`\n--- ${table}  body_domains @> [${needle}]  (${data!.length}) ---`)
      for (const r of data as Array<{ monday_item_id: string; body_text: string | null; body_domains: string[] | null }>) {
        console.log(`  item=${r.monday_item_id}`)
        console.log(`    body_domains=${JSON.stringify(r.body_domains)}`)
        console.log(`    body_text="${(r.body_text ?? '').replace(/\s+/g, ' ').slice(0, 400)}"`)
      }
    }
  }
}

// Re-run the canonical matcher with several normalized inputs.
async function runMatcher(svc: SupabaseClient) {
  for (const d of ['casinoohneoasis.com', 'onlinecasinoohneoasis.com', 'onlinecasinoohneoasis.de.com']) {
    const { data, error } = await svc.rpc('search_website_on_monday', { p_domain: d })
    if (error) { console.warn(`  ! search_website_on_monday(${d}): ${error.message}`); continue }
    console.log(`\nsearch_website_on_monday('${d}') → ${(data ?? []).length} hits`)
    for (const m of (data ?? []) as Array<{ board: string; item_id: string; item_name: string; match_kind: string }>) {
      console.log(`  ✓ ${m.board} / ${m.item_id} / "${m.item_name}" — ${m.match_kind}`)
    }
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('############ BOARD HITS ############')
  await dumpBoardHits(svc)
  console.log('\n############ UPDATE HITS (body_text ILIKE) ############')
  await dumpUpdateHits(svc)
  console.log('\n############ UPDATE HITS (body_domains @>) ############')
  await dumpBodyDomainsContains(svc)
  console.log('\n############ CANONICAL MATCHER ############')
  await runMatcher(svc)
}

main().catch(e => { console.error(e); process.exit(1) })
