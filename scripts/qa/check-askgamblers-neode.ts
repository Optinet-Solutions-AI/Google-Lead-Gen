/**
 * One-shot: search ALL Monday board + updates tables for any trace of
 * "askgamblers" or "neode" — broader than the canonical matcher's lookup.
 * If nothing appears anywhere, the overrides on leads 680/725/8689/8776
 * are user error (misuse of "Yes on Monday"), not a matcher bug.
 *
 * Read-only. Run: npx tsx scripts/qa/check-askgamblers-neode.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const NEEDLES = ['askgamblers', 'neode']

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

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  for (const needle of NEEDLES) {
    console.log(`\n${'='.repeat(60)}\nSearching for "${needle}"`)
    let any = false

    for (const t of ITEM_TABLES) {
      const { data } = await svc
        .from(t)
        .select('monday_item_id, name, website, website_normalized')
        .or(`name.ilike.%${needle}%,website.ilike.%${needle}%,website_normalized.ilike.%${needle}%`)
        .limit(10)
      const rows = data ?? []
      if (rows.length === 0) continue
      any = true
      console.log(`  ${t}: ${rows.length} hit(s)`)
      for (const r of rows as Array<{ monday_item_id: string; name: string; website: string; website_normalized: string }>) {
        console.log(`    • item=${r.monday_item_id}  name="${r.name}"  website="${r.website}"  normalized="${r.website_normalized}"`)
      }
    }

    for (const t of UPDATE_TABLES) {
      const { data } = await svc
        .from(t)
        .select('monday_item_id, body_text, body_domains')
        .ilike('body_text', `%${needle}%`)
        .limit(5)
      const rows = data ?? []
      if (rows.length === 0) continue
      any = true
      console.log(`  ${t}: ${rows.length} update body hit(s)`)
      for (const r of rows as Array<{ monday_item_id: string; body_text: string; body_domains: string[] }>) {
        const snip = (r.body_text ?? '').replace(/\s+/g, ' ').slice(0, 160)
        console.log(`    • item=${r.monday_item_id}  body="${snip}…"`)
        console.log(`        body_domains=[${(r.body_domains ?? []).slice(0, 10).join(', ')}]`)
      }
    }

    if (!any) console.log('  (nothing anywhere)')
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
