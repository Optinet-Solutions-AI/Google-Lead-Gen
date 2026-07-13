/**
 * Supriya "Batch 1873" feedback: leads showing "No" under Is-on-Monday that
 * ARE on Monday.
 *   1. esportsinsider.com — only appears in the UPDATES feed of coincierge.de
 *   2. casibella.com      — on Leads (as casibella.com/online-casinos-schweiz/)
 *                           AND Affiliates (as bare "casibella.com")
 *
 * Hypothesis: the live search_website_on_monday (20260625 mirror-domain
 * rebuild) silently dropped the exact_name/registered_name and
 * mentioned_in_updates tiers, so name-only + updates-only items no longer
 * match.
 *
 * Read-only.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const ITEM_TABLES = [
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

const DOMAINS = ['esportsinsider.com', 'casibella.com', 'coincierge.de']

async function runMatcher(svc: SupabaseClient) {
  console.log('############ CANONICAL MATCHER (live) ############')
  for (const d of DOMAINS) {
    const { data, error } = await svc.rpc('search_website_on_monday', { p_domain: d })
    if (error) { console.log(`  ! ${d}: ${error.message}`); continue }
    const hits = (data ?? []) as Array<{ board: string; item_id: string; item_name: string; match_kind: string }>
    console.log(`\nsearch_website_on_monday('${d}') → ${hits.length} hit(s)`)
    for (const m of hits) console.log(`  ✓ ${m.board} / ${m.item_id} / "${m.item_name}" — ${m.match_kind}`)
  }
}

async function dumpItemHits(svc: SupabaseClient) {
  console.log('\n############ ITEM ROWS in replica (name / website / normalized) ############')
  for (const needle of ['esportsinsider', 'casibella']) {
    for (const table of ITEM_TABLES) {
      const { data, error } = await svc
        .from(table)
        .select('monday_item_id, name, website, website_normalized')
        .or(`name.ilike.%${needle}%,website.ilike.%${needle}%,website_normalized.ilike.%${needle}%`)
        .limit(10)
      if (error) { console.log(`  ! ${table}/${needle}: ${error.message}`); continue }
      if (!data?.length) continue
      console.log(`\n--- ${table}  needle=${needle}  (${data.length}) ---`)
      for (const r of data as Array<{ monday_item_id: string; name: string; website: string | null; website_normalized: string | null }>) {
        console.log(`  item=${r.monday_item_id}  name="${r.name}"  website="${r.website}"  normalized="${r.website_normalized}"`)
      }
    }
  }
}

async function dumpUpdateHits(svc: SupabaseClient) {
  console.log('\n############ UPDATE ROWS mentioning esportsinsider ############')
  for (const table of UPDATE_TABLES) {
    const { data, error } = await svc
      .from(table)
      .select('monday_item_id, body_text, body_domains')
      .contains('body_domains', ['esportsinsider.com'])
      .limit(10)
    if (error) { console.log(`  ! ${table}: ${error.message}`); continue }
    if (!data?.length) continue
    console.log(`\n--- ${table}  body_domains @> [esportsinsider.com]  (${data.length}) ---`)
    for (const r of data as Array<{ monday_item_id: string; body_text: string | null; body_domains: string[] | null }>) {
      console.log(`  item=${r.monday_item_id}  body_domains=${JSON.stringify(r.body_domains)}`)
      console.log(`    body_text="${(r.body_text ?? '').replace(/\s+/g, ' ').slice(0, 200)}"`)
    }
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set (.env.local)')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  await runMatcher(svc)
  await dumpItemHits(svc)
  await dumpUpdateHits(svc)
}

main().catch(e => { console.error(e); process.exit(1) })
