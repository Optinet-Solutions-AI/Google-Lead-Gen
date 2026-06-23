/**
 * Triage four QA reports about Monday-match attribution:
 *
 *   lead 25806 — tool says not on Monday; user says it IS (not-relevant board)
 *   lead 26568 — same shape — tool says not on Monday; not-relevant board hit
 *   lead 26082 — tool says "leads"; user says it's actually "affiliates"
 *   lead 34245 — anastassia-lauterbach.de — tool says NOT affiliate;
 *                user says it's listed as Affiliate L7
 *
 * For each: pull the lead row, the matching Monday-board rows (by
 * normalized domain), and print what each side says so we can see
 * whether the bug is in the match logic, the sync, or the data.
 *
 *   npx tsx scripts/qa/triage-monday-mismatches.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const TARGETS = [25806, 26568, 26082, 34245]

function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
    .trim()
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { persistSession: false } })

  for (const id of TARGETS) {
    console.log(`\n==================== lead ${id} ====================`)
    const { data: lead } = await svc
      .from('google_lead_gen_table')
      .select(
        [
          'id, url, domain, country_code, keyword',
          'is_affiliate, affiliate_checked_at',
          'is_on_monday, monday_board, monday_item_id, monday_pushed_item_id, monday_pushed_by, pushed_to_monday_at',
          'is_not_relevant, not_relevant_marked_by, not_relevant_marked_at',
          'is_rooster_partner, rooster_checked_at',
          'force_enrich, inherited_from_lead_id',
        ].join(', '),
      )
      .eq('id', id)
      .maybeSingle()

    if (!lead) {
      console.log('  (lead not found)')
      continue
    }
    const l = lead as Record<string, unknown>
    console.log('Lead row:')
    for (const [k, v] of Object.entries(l)) console.log(`  ${k} = ${JSON.stringify(v)}`)

    const norm = normalizeDomain((l.domain as string) || (l.url as string))
    if (!norm) {
      console.log('  (no domain to match against Monday)')
      continue
    }
    console.log(`Normalized domain for match: "${norm}"`)

    const boardTables: Array<{ key: string; table: string; nameCol: string }> = [
      { key: 'leads', table: 'leads_table', nameCol: 'item_name' },
      { key: 'affiliates', table: 'affiliates_table', nameCol: 'item_name' },
      { key: 'not_relevant_leads', table: 'not_relevant_leads_table', nameCol: 'item_name' },
      { key: 'email_undelivered_leads', table: 'email_undelivered_leads_table', nameCol: 'item_name' },
    ]
    for (const b of boardTables) {
      const { data: hits, error } = await svc
        .from(b.table)
        .select(`${b.nameCol}, monday_item_id`)
        .ilike(b.nameCol, `%${norm}%`)
        .limit(5)
      if (error) {
        console.log(`  ${b.key.padEnd(28)}  ERROR ${error.message}`)
        continue
      }
      const rows = (hits ?? []) as Array<Record<string, unknown>>
      if (rows.length === 0) {
        console.log(`  ${b.key.padEnd(28)}  (no match)`)
        continue
      }
      for (const r of rows) {
        console.log(`  ${b.key.padEnd(28)}  ${r[b.nameCol]}  monday_item_id=${r.monday_item_id}`)
      }
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
