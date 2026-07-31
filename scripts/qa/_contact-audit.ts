/**
 * LGP-184 — Contact-extraction v2 baseline audit.
 * Measures current coverage across leads + contact_table so we have a
 * number to optimize against.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '—')

;(async () => {
  // --- Lead-level coverage
  const { count: totalLeads } = await s.from('google_lead_gen_table').select('id', { count: 'exact', head: true })
  const { count: affiliates } = await s.from('google_lead_gen_table').select('id', { count: 'exact', head: true }).eq('is_affiliate', true)
  const { count: checked } = await s.from('google_lead_gen_table').select('id', { count: 'exact', head: true }).not('contact_checked_at', 'is', null)
  const { count: hasDetails } = await s.from('google_lead_gen_table').select('id', { count: 'exact', head: true }).eq('has_contact_details', true)
  const { count: affChecked } = await s.from('google_lead_gen_table').select('id', { count: 'exact', head: true }).eq('is_affiliate', true).not('contact_checked_at', 'is', null)
  const { count: affHasDetails } = await s.from('google_lead_gen_table').select('id', { count: 'exact', head: true }).eq('is_affiliate', true).eq('has_contact_details', true)

  console.log('=== LEAD-LEVEL COVERAGE ===')
  console.log(`  total leads:                 ${totalLeads}`)
  console.log(`  affiliates:                  ${affiliates}`)
  console.log(`  contact stage RUN (checked): ${checked}  (${pct(checked ?? 0, totalLeads ?? 0)} of all)`)
  console.log(`  has_contact_details = true:  ${hasDetails}  (${pct(hasDetails ?? 0, checked ?? 0)} of checked)`)
  console.log(`  affiliates checked:          ${affChecked}  (${pct(affChecked ?? 0, affiliates ?? 0)} of affiliates)`)
  console.log(`  affiliates WITH details:     ${affHasDetails}  (${pct(affHasDetails ?? 0, affChecked ?? 0)} of aff checked)`)

  // --- contact_table field-level coverage (paginate the jsonb)
  const rows: Array<{ emails: unknown; phones: unknown; contact_page_url: string | null; source: string | null }> = []
  let from = 0
  while (true) {
    const { data } = await s.from('contact_table').select('emails, phones, contact_page_url, source').order('id', { ascending: true }).range(from, from + 999)
    const chunk = (data ?? []) as typeof rows
    rows.push(...chunk)
    if (chunk.length < 1000) break
    from += 1000
    if (from > 100000) break
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v : [])
  let withEmail = 0, withPhone = 0, withLink = 0, emptyRow = 0
  let totalEmails = 0, totalPhones = 0
  const bySource: Record<string, number> = {}
  const bySourceEmail: Record<string, number> = {}
  for (const r of rows) {
    const e = arr(r.emails).length, p = arr(r.phones).length
    totalEmails += e; totalPhones += p
    if (e > 0) withEmail++
    if (p > 0) withPhone++
    if (r.contact_page_url) withLink++
    if (e === 0 && p === 0 && !r.contact_page_url) emptyRow++
    const src = r.source ?? '(none)'
    bySource[src] = (bySource[src] ?? 0) + 1
    if (e > 0) bySourceEmail[src] = (bySourceEmail[src] ?? 0) + 1
  }
  const N = rows.length
  console.log(`\n=== CONTACT_TABLE FIELD COVERAGE (${N} rows) ===`)
  console.log(`  rows with >=1 email:      ${withEmail}  (${pct(withEmail, N)})   total emails: ${totalEmails}`)
  console.log(`  rows with >=1 phone:      ${withPhone}  (${pct(withPhone, N)})   total phones: ${totalPhones}`)
  console.log(`  rows with contact link:   ${withLink}  (${pct(withLink, N)})`)
  console.log(`  rows with NOTHING:        ${emptyRow}  (${pct(emptyRow, N)})   <-- checked but zero contact signal`)

  console.log(`\n=== BY EXTRACTION TIER (source) ===`)
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} rows=${String(v).padStart(5)}  with-email=${bySourceEmail[k] ?? 0}`)
  }

  console.log(`\n=== KEY GAPS (v2 targets) ===`)
  console.log(`  • phones far below emails: ${totalPhones} phones vs ${totalEmails} emails — dotted/intl formats unmatched (LGP-190)`)
  console.log(`  • 0 social links, 0 addresses, 0 contact-form detection captured today (LGP-188/191/193)`)
  console.log(`  • ${emptyRow} "checked-but-nothing" rows = the recovery opportunity (LGP-192 JSON-LD, LGP-203 worker)`)
  console.log(`  • attribution is tier-level only — no per-contact source URL/method/confidence (LGP-186/196-199)`)
})().catch(e => { console.error(e); process.exit(1) })
