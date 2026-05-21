/**
 * Quantify how many Monday items across the 4 boards have an empty
 * website_normalized but a domain-like name. This decides the shape
 * of the matcher fix for Charisse's QA report.
 *
 * "Domain-like name" = contains at least one '.' and matches the
 * extract regex used by extract_normalized_domains.
 * Read-only.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const BOARDS = [
  'leads_table',
  'affiliates_table',
  'not_relevant_leads_table',
  'email_undelivered_leads_table',
] as const

async function summarize(svc: SupabaseClient, table: string) {
  const { count: total } = await svc.from(table).select('monday_item_id', { head: true, count: 'exact' })
  // Empty website (string '' OR null)
  const { count: emptyWebsite, error: e1 } = await svc
    .from(table)
    .select('monday_item_id', { head: true, count: 'exact' })
    .or('website_normalized.is.null,website_normalized.eq.')
  if (e1) console.warn(`  ! ${table}: ${e1.message}`)
  // Of those, how many have a name that contains a dot
  const { count: emptyButNameDomain, error: e2 } = await svc
    .from(table)
    .select('monday_item_id', { head: true, count: 'exact' })
    .or('website_normalized.is.null,website_normalized.eq.')
    .ilike('name', '%.%')
  if (e2) console.warn(`  ! ${table}: ${e2.message}`)

  console.log(`${table.padEnd(38)} total=${total}  empty_website=${emptyWebsite}  empty_but_name_has_dot=${emptyButNameDomain}`)
}

async function dumpSample(svc: SupabaseClient, table: string) {
  const { data } = await svc
    .from(table)
    .select('monday_item_id, name, website')
    .or('website_normalized.is.null,website_normalized.eq.')
    .ilike('name', '%.%')
    .limit(15)
  if ((data ?? []).length === 0) return
  console.log(`\n--- ${table}  sample (15 of empty_website + dot_name) ---`)
  for (const r of data as Array<{ monday_item_id: string; name: string; website: string | null }>) {
    console.log(`  item=${r.monday_item_id}  name="${r.name}"  website="${r.website ?? ''}"`)
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('### counts ###')
  for (const t of BOARDS) await summarize(svc, t)
  console.log('\n### samples ###')
  for (const t of BOARDS) await dumpSample(svc, t)
}

main().catch(e => { console.error(e); process.exit(1) })
