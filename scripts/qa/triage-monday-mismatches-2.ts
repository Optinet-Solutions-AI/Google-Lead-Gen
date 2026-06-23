/**
 * Triage v2: call search_website_on_monday on each suspicious
 * domain and also raw-scan the Monday replica tables by name
 * pattern. Three things to see per domain:
 *
 *   (a) what the live match RPC returns
 *   (b) raw rows in each replica table whose name OR website mentions
 *       the domain
 *   (c) the lead's current is_on_monday / monday_board / match_kind
 *
 *   npx tsx scripts/qa/triage-monday-mismatches-2.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

type Target = { leadId: number; domain: string; note: string }
const TARGETS: Target[] = [
  { leadId: 25806, domain: 'wettanbieter.de', note: 'Charisse: says not on Monday, but in not-relevant' },
  { leadId: 26568, domain: 'casino.welt.de', note: 'Charisse: says not on Monday, but in not-relevant' },
  { leadId: 26082, domain: 'casino.org', note: 'Charisse: tool says leads, actually affiliates' },
  { leadId: 34245, domain: 'anastassia-lauterbach.de', note: 'Darren: tool says not-affiliate, listed Affiliate L7' },
]

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { persistSession: false } })

  for (const t of TARGETS) {
    console.log(`\n================ lead ${t.leadId}  ${t.domain} ================`)
    console.log(`note: ${t.note}`)

    // (a) live match RPC
    const { data: rpc, error: rpcErr } = await svc.rpc('search_website_on_monday', {
      p_domain: t.domain,
    })
    if (rpcErr) console.log(`  RPC error: ${rpcErr.message}`)
    else console.log(`  search_website_on_monday("${t.domain}") -> ${JSON.stringify(rpc)}`)

    // (b) raw scan of each replica table
    const tables = ['leads_table', 'affiliates_table', 'not_relevant_leads_table', 'email_undelivered_leads_table']
    for (const tbl of tables) {
      const { data: byWebsite } = await svc
        .from(tbl)
        .select('name, website, website_normalized, monday_item_id')
        .ilike('website_normalized', `%${t.domain}%`)
        .limit(5)
      const { data: byName } = await svc
        .from(tbl)
        .select('name, website, website_normalized, monday_item_id')
        .ilike('name', `%${t.domain}%`)
        .limit(5)
      const seen = new Map<string, Record<string, unknown>>()
      for (const r of [...(byWebsite ?? []), ...(byName ?? [])] as Array<Record<string, unknown>>) {
        seen.set(String(r.monday_item_id), r)
      }
      if (seen.size === 0) {
        console.log(`  ${tbl.padEnd(34)}  (no match)`)
        continue
      }
      for (const r of seen.values()) {
        console.log(
          `  ${tbl.padEnd(34)}  name="${r.name}"  website_normalized="${r.website_normalized}"  item=${r.monday_item_id}`,
        )
      }
    }

    // (c) what the lead row currently says
    const { data: lead } = await svc
      .from('google_lead_gen_table')
      .select('is_on_monday, monday_board, monday_item_id, monday_match_kind, is_affiliate')
      .eq('id', t.leadId)
      .maybeSingle()
    if (lead) {
      console.log(`  lead row: ${JSON.stringify(lead)}`)
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
