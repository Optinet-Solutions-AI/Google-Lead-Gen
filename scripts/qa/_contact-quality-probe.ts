/**
 * Post-backfill data-quality probe. Checks for phone OVER-extraction
 * (valid-format-but-not-really-a-phone) and confirms the v2 channels
 * (socials/address/forms) actually persisted.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

;(async () => {
  // Pull a big sample of contact rows with their arrays/jsonb.
  const rows: Array<{ lead_id: number; phones: string[] | null; emails: string[] | null; socials: unknown; address: string | null; contact_forms: unknown; items: unknown }> = []
  let after = 0
  for (;;) {
    const { data, error } = await s
      .from('contact_table')
      .select('lead_id, phones, emails, socials, address, contact_forms, items')
      .gt('lead_id', after)
      .order('lead_id', { ascending: true })
      .limit(1000)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    rows.push(...(data as typeof rows))
    after = data[data.length - 1]!.lead_id
    if (data.length < 1000) break
  }
  console.log(`contact_table rows sampled: ${rows.length}`)

  // --- Phone distribution ---
  const phoneCounts = rows.map(r => (Array.isArray(r.phones) ? r.phones.length : 0)).filter(n => n > 0).sort((a, b) => a - b)
  const totalPhones = phoneCounts.reduce((a, b) => a + b, 0)
  const p = (q: number) => phoneCounts[Math.floor(phoneCounts.length * q)] ?? 0
  console.log(`\n=== PHONE DISTRIBUTION (${phoneCounts.length} rows with >=1 phone) ===`)
  console.log(`  total phones: ${totalPhones}   mean/row: ${(totalPhones / phoneCounts.length).toFixed(1)}`)
  console.log(`  median: ${p(0.5)}   p90: ${p(0.9)}   p95: ${p(0.95)}   p99: ${p(0.99)}   max: ${phoneCounts[phoneCounts.length - 1]}`)
  const over10 = phoneCounts.filter(n => n > 10).length
  const over20 = phoneCounts.filter(n => n > 20).length
  console.log(`  rows with >10 phones: ${over10}   >20: ${over20}`)

  // Worst offenders — show their phones so we can eyeball junk.
  const worst = [...rows].filter(r => Array.isArray(r.phones)).sort((a, b) => (b.phones!.length) - (a.phones!.length)).slice(0, 5)
  console.log(`\n=== TOP 5 PHONE-HEAVY LEADS (eyeball for junk) ===`)
  for (const r of worst) {
    console.log(`  lead ${r.lead_id}: ${r.phones!.length} phones → ${JSON.stringify(r.phones!.slice(0, 12))}${r.phones!.length > 12 ? ' …' : ''}`)
  }

  // --- v2 channel persistence ---
  const withSocials = rows.filter(r => Array.isArray(r.socials) && (r.socials as unknown[]).length > 0).length
  const socialTotal = rows.reduce((a, r) => a + (Array.isArray(r.socials) ? (r.socials as unknown[]).length : 0), 0)
  const withAddress = rows.filter(r => typeof r.address === 'string' && r.address.trim()).length
  const withForms = rows.filter(r => Array.isArray(r.contact_forms) && (r.contact_forms as unknown[]).length > 0).length
  const withItems = rows.filter(r => Array.isArray(r.items) && (r.items as unknown[]).length > 0).length
  console.log(`\n=== v2 CHANNEL PERSISTENCE (confirms backfill wrote them) ===`)
  console.log(`  rows with socials:  ${withSocials}   (total handles: ${socialTotal})`)
  console.log(`  rows with address:  ${withAddress}`)
  console.log(`  rows with forms:    ${withForms}`)
  console.log(`  rows with items[]:  ${withItems}`)

  // --- Method breakdown from items[] ---
  const byMethod: Record<string, number> = {}
  for (const r of rows) {
    if (!Array.isArray(r.items)) continue
    for (const it of r.items as Array<{ method?: string }>) {
      const m = it.method ?? 'unknown'
      byMethod[m] = (byMethod[m] ?? 0) + 1
    }
  }
  console.log(`\n=== ITEM METHOD BREAKDOWN (which tool found each contact) ===`)
  for (const [m, n] of Object.entries(byMethod).sort((a, b) => b[1] - a[1])) console.log(`  ${m.padEnd(18)} ${n}`)
})().catch(e => { console.error(e); process.exit(1) })
