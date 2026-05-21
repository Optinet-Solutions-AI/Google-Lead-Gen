/**
 * One-off: dig into lead 12530 (casinoohneoasis.com) where Charisse
 * reports it IS on Monday but the matcher says is_on_monday=false.
 * Read-only.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const target = 'casinoohneoasis.com'

  // 1. Lead row, full
  const { data: lead } = await svc
    .from('google_lead_gen_table')
    .select('*')
    .eq('id', 12530)
    .maybeSingle()
  console.log('--- lead 12530 ---')
  console.log(JSON.stringify(lead, null, 2))

  // 2. Any board rows that ILIKE %casinoohneoasis% across all 4 boards
  for (const t of ['leads_table', 'affiliates_table', 'not_relevant_leads_table', 'email_undelivered_leads_table']) {
    const { data, error } = await svc
      .from(t)
      .select('monday_item_id, name, website, website_normalized')
      .ilike('website_normalized', `%${target}%`)
      .limit(10)
    if (error) { console.warn(`  ! ${t}: ${error.message}`); continue }
    if ((data ?? []).length > 0) {
      console.log(`\n--- ${t} ILIKE %${target}% (${data!.length}) ---`)
      for (const r of data as Array<Record<string, unknown>>) console.log(JSON.stringify(r))
    }
  }

  // 3. Updates: any body mentioning the exact string
  for (const t of ['leads_updates_table', 'affiliates_updates_table', 'not_relevant_leads_updates_table', 'email_undelivered_leads_updates_table']) {
    const { data, error } = await svc
      .from(t)
      .select('monday_item_id, body_text, body_domains')
      .ilike('body_text', `%${target}%`)
      .limit(10)
    if (error) { console.warn(`  ! ${t}: ${error.message}`); continue }
    if ((data ?? []).length > 0) {
      console.log(`\n--- ${t} body ILIKE %${target}% (${data!.length}) ---`)
      for (const r of data as Array<{ monday_item_id: string; body_text: string; body_domains: string[] }>) {
        console.log(`item=${r.monday_item_id}`)
        console.log(`body_domains=${JSON.stringify(r.body_domains)}`)
        console.log(`body_text="${(r.body_text ?? '').replace(/\s+/g, ' ').slice(0, 500)}"`)
        console.log('---')
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
