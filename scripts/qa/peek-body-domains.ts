/**
 * One-off: dump the full body_domains array on a specific updates-table
 * row so we can confirm whether the glue-bug fix's regeneration UPDATE
 * actually ran. The diagnose script only previews the first 6 entries
 * alphabetically, which hides the relevant ones for this data.
 *
 * Run: npx tsx scripts/qa/peek-body-domains.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const ITEM_ID = '2539285865'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await svc
    .from('affiliates_updates_table')
    .select('monday_update_id, monday_item_id, body_domains')
    .eq('monday_item_id', ITEM_ID)
  if (error) throw error
  const rows = (data ?? []) as Array<{ monday_update_id: string; monday_item_id: string; body_domains: string[] }>

  console.log(`Found ${rows.length} update row(s) on item ${ITEM_ID}\n`)
  for (const r of rows) {
    console.log(`--- update ${r.monday_update_id} ---`)
    const arr = r.body_domains ?? []
    console.log(`  ${arr.length} entries\n`)
    const buggy = arr.filter(d => d.startsWith('at') && d.length > 4 && !['at', 'attack', 'atom'].includes(d))
    const correct = arr.filter(d => !d.startsWith('at') || d === 'at')
    console.log(`  Entries starting with "at" (potential glue-bug leftovers):`)
    for (const d of buggy) console.log(`    ${d}`)
    console.log(`\n  All entries (alphabetical):`)
    for (const d of arr) console.log(`    ${d}`)

    const checkDomains = ['casinomithandyrechnung.at', 'beste-legale-casinos.at', 'seriosecasinos.at', 'osterreich-casino-spieler.com']
    console.log(`\n  Presence check for expected targets:`)
    for (const d of checkDomains) {
      console.log(`    ${arr.includes(d) ? '✓' : '✗'}  ${d}`)
    }
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
