/**
 * One-off data cleanup: re-filter ALREADY-STORED phones in contact_table
 * through the v2 precision gate (sanitizeStoredPhone). Fixes rows the HTML
 * backfill couldn't reach — old leads whose page HTML is no longer cached
 * but whose contact row still holds pre-gate junk ("88.0665779", "218.463
 * 134", coordinates, decimals). Works purely on the stored strings, no
 * HTML needed.
 *
 * Re-upserts changed rows via upsert_contact_for_lead_v2 so
 * has_contact_details is recomputed. Skips source='manual' (never touch
 * hand-entered contacts).
 *
 *   npx tsx scripts/qa/_contact-phone-cleanup.ts --dry-run   # measure
 *   npx tsx scripts/qa/_contact-phone-cleanup.ts             # apply
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { sanitizeStoredPhone } from '../../lib/contact-extraction/extract'

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const DRY_RUN = process.argv.includes('--dry-run')

type PhoneItem = { kind: string; value: string; method?: string; sourceUrl?: string; confidence?: number; label?: string }
type Row = {
  lead_id: number
  emails: string[] | null
  phones: string[] | null
  contact_page_url: string | null
  source: string | null
  raw: unknown
  items: PhoneItem[] | null
  socials: unknown
  address: string | null
  contact_forms: unknown
}

;(async () => {
  console.log(`[phone-cleanup] mode=${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`)
  const stats = { scanned: 0, rowsWithPhones: 0, changed: 0, phonesBefore: 0, phonesAfter: 0, itemsDropped: 0, errors: 0 }
  let after = -1

  for (;;) {
    const { data, error } = await s
      .from('contact_table')
      .select('lead_id, emails, phones, contact_page_url, source, raw, items, socials, address, contact_forms')
      .gt('lead_id', after)
      .order('lead_id', { ascending: true })
      .limit(500)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break

    for (const row of data as Row[]) {
      stats.scanned++
      after = row.lead_id
      const phones = Array.isArray(row.phones) ? row.phones : []
      if (phones.length === 0) continue
      if (row.source === 'manual') continue
      stats.rowsWithPhones++
      stats.phonesBefore += phones.length

      // If any stored phone is +intl, allow bare intl runs during re-check.
      const sawIntl = phones.some(p => typeof p === 'string' && p.trim().startsWith('+'))
      const cleanedPhones = Array.from(
        new Set(phones.map(p => sanitizeStoredPhone(p, sawIntl)).filter((p): p is string => !!p)),
      )
      stats.phonesAfter += cleanedPhones.length

      // Re-filter phone items the same way; keep non-phone items untouched.
      const items = Array.isArray(row.items) ? row.items : []
      const cleanedItems = items.filter(it => {
        if (it.kind !== 'phone') return true
        const norm = sanitizeStoredPhone(it.value, sawIntl)
        return !!norm && cleanedPhones.includes(norm)
      }).map(it => {
        if (it.kind !== 'phone') return it
        const norm = sanitizeStoredPhone(it.value, sawIntl)
        return norm ? { ...it, value: norm } : it
      })
      stats.itemsDropped += items.length - cleanedItems.length

      const unchanged =
        cleanedPhones.length === phones.length &&
        cleanedPhones.every((p, i) => p === phones[i])
      if (unchanged) continue
      stats.changed++

      if (!DRY_RUN) {
        const { error: rpcErr } = await s.rpc('upsert_contact_for_lead_v2', {
          p_lead_id: row.lead_id,
          p_emails: row.emails ?? [],
          p_phones: cleanedPhones,
          p_contact_page_url: row.contact_page_url,
          p_source: row.source ?? 'regex',
          p_raw: row.raw ?? {},
          p_items: cleanedItems,
          p_socials: row.socials ?? [],
          p_address: row.address,
          p_contact_forms: row.contact_forms ?? [],
        })
        if (rpcErr) {
          console.error(`  ! lead ${row.lead_id}: ${rpcErr.message}`)
          stats.errors++
        }
      }
    }
    if (stats.scanned % 2000 === 0 || data.length < 500) {
      console.log(`  scanned=${stats.scanned} changed=${stats.changed} phones ${stats.phonesBefore}→${stats.phonesAfter}`)
    }
    if (data.length < 500) break
  }

  console.log('\n===== phone cleanup complete =====')
  console.table(stats)
  if (DRY_RUN) console.log('(dry-run — no rows written)')
})().catch(e => { console.error(e); process.exit(1) })
