/**
 * One-off: peek exactly what's in batch 736 (Darren's flagged
 * "online casino New Zealand" scrape) so we can verify which rows
 * would be hidden by an is_affiliate=false filter and which still
 * leak through.
 *
 * Read-only. Run: npx tsx scripts/qa/peek-batch-736.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select(
      'domain, url, overall_position, result_type, is_affiliate, is_rooster_partner, is_on_monday, is_not_relevant, not_relevant_marked_by, affiliate_checked_at',
    )
    .eq('batch_id', 736)
    .order('overall_position', { ascending: true, nullsFirst: false })

  if (error) throw error
  type Row = {
    domain: string | null
    url: string | null
    overall_position: number | null
    result_type: string | null
    is_affiliate: boolean | null
    is_rooster_partner: boolean | null
    is_on_monday: boolean | null
    is_not_relevant: boolean | null
    not_relevant_marked_by: string | null
    affiliate_checked_at: string | null
  }
  const rows = (data ?? []) as Row[]
  console.log(`Batch 736 — ${rows.length} rows\n`)

  const headers = ['pos', 'aff', 'roo', 'mon', 'notRel', 'markedBy', 'domain']
  console.log(headers.map(h => h.padEnd(12)).join(' '))
  for (const r of rows) {
    const aff = r.is_affiliate === null ? '?' : r.is_affiliate ? 'Y' : 'N'
    const roo = r.is_rooster_partner === null ? '?' : r.is_rooster_partner ? 'Y' : 'N'
    const mon = r.is_on_monday === null ? '?' : r.is_on_monday ? 'Y' : 'N'
    const nr = r.is_not_relevant ? 'Y' : 'N'
    const by = (r.not_relevant_marked_by ?? '—').toString()
    console.log(
      `${String(r.overall_position ?? '-').padEnd(12)} ${aff.padEnd(12)} ${roo.padEnd(12)} ${mon.padEnd(12)} ${nr.padEnd(12)} ${by.padEnd(20)} ${r.domain}`,
    )
  }

  const visible = rows.filter(r => !r.is_not_relevant).length
  const hidden = rows.filter(r => r.is_not_relevant).length
  const operatorFlagged = rows.filter(r => r.not_relevant_marked_by === 'operator_denylist').length
  console.log(`\nVisible (is_not_relevant=false): ${visible}`)
  console.log(`Hidden  (is_not_relevant=true):  ${hidden}`)
  console.log(`  of which 'operator_denylist': ${operatorFlagged}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
