/**
 * LGP-208 — Contact extraction v2 backfill.
 *
 * Re-runs the v2 extractor (Tier 1 only: regex + JSON-LD + anti-obfuscation
 * over the ALREADY-cached multi-page HTML in fetched_html_cache) across
 * existing leads, so the new channels — per-item provenance, socials,
 * postal address, contact forms, validated phones, ranked contact links —
 * populate WITHOUT re-scraping anyone. No OpenAI / Hunter calls here (those
 * cost money + hit rate limits; Tier 1 is free and offline).
 *
 * Only writes when the extractor finds a real channel, so it never
 * clobbers a lead's existing LLM/Hunter-sourced contacts with an empty
 * result. By default skips leads whose contact row already has v2 items[]
 * (pass --all to re-run everyone).
 *
 *   npx tsx scripts/qa/_contact-backfill.ts --dry-run            # measure only
 *   npx tsx scripts/qa/_contact-backfill.ts --limit=200          # first 200
 *   npx tsx scripts/qa/_contact-backfill.ts                      # full run
 *   npx tsx scripts/qa/_contact-backfill.ts --all                # re-run v2 rows too
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { extractContacts } from '../../lib/contact-extraction/extract'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const ALL = argv.includes('--all')
const limitArg = argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]!, 10) : Infinity
const PAGE = 300

type CacheRow = { lead_id: number; url: string; html: string | null }

async function* candidateLeadIds(): AsyncGenerator<number> {
  // Page through fetched_html_cache by lead_id. We fetch ids (+ a cheap
  // fetch_error filter) first, then pull HTML per page, to keep memory
  // bounded — HTML blobs can be hundreds of KB each.
  let after = 0
  for (;;) {
    const { data, error } = await s
      .from('fetched_html_cache')
      .select('lead_id')
      .is('fetch_error', null)
      .gt('lead_id', after)
      .order('lead_id', { ascending: true })
      .limit(PAGE)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) return
    for (const row of data) yield (row as { lead_id: number }).lead_id
    after = (data[data.length - 1] as { lead_id: number }).lead_id
    if (data.length < PAGE) return
  }
}

async function alreadyHasV2(leadIds: number[]): Promise<Set<number>> {
  if (ALL || leadIds.length === 0) return new Set()
  const { data, error } = await s
    .from('contact_table')
    .select('lead_id, items')
    .in('lead_id', leadIds)
    .not('items', 'is', null)
  if (error) throw new Error(error.message)
  return new Set(
    (data ?? [])
      .filter(r => Array.isArray((r as { items: unknown }).items) && ((r as { items: unknown[] }).items).length > 0)
      .map(r => (r as { lead_id: number }).lead_id),
  )
}

async function main() {
  console.log(
    `[backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'LIVE'} scope=${ALL ? 'all-cached' : 'missing-v2'} limit=${LIMIT === Infinity ? '∞' : LIMIT}`,
  )

  const stats = {
    scanned: 0,
    skippedV2: 0,
    noHtml: 0,
    unproductive: 0,
    written: 0,
    emails: 0,
    phones: 0,
    socials: 0,
    addresses: 0,
    forms: 0,
    links: 0,
  }

  // Buffer candidate ids in pages so we can batch the "already has v2" check
  // and the HTML pull.
  let batch: number[] = []
  const flush = async () => {
    if (batch.length === 0) return
    const skip = await alreadyHasV2(batch)
    const toProcess = batch.filter(id => !skip.has(id))
    stats.skippedV2 += batch.length - toProcess.length
    batch = []
    if (toProcess.length === 0) return

    const { data, error } = await s
      .from('fetched_html_cache')
      .select('lead_id, url, html')
      .in('lead_id', toProcess)
    if (error) throw new Error(error.message)

    for (const row of (data ?? []) as CacheRow[]) {
      stats.scanned++
      const html = row.html ?? ''
      if (!html || html.length < 50) {
        stats.noHtml++
        continue
      }
      const r = extractContacts(html, row.url)
      const productive =
        r.emails.length > 0 ||
        r.phones.length > 0 ||
        r.contactPageUrl !== null ||
        r.socials.length > 0 ||
        r.contactForms.length > 0 ||
        r.address !== null
      if (!productive) {
        stats.unproductive++
        continue
      }

      stats.emails += r.emails.length
      stats.phones += r.phones.length
      stats.socials += r.socials.length
      stats.forms += r.contactForms.length
      stats.links += r.contactLinks.length
      if (r.address) stats.addresses++

      if (!DRY_RUN) {
        const source = html.includes('<!-- PAGE: ') ? 'multi_page' : 'regex'
        const { error: rpcErr } = await s.rpc('upsert_contact_for_lead_v2', {
          p_lead_id: row.lead_id,
          p_emails: r.emails,
          p_phones: r.phones,
          p_contact_page_url: r.contactPageUrl,
          p_source: source,
          p_raw: { regex: r.raw, backfill: true },
          p_items: r.items,
          p_socials: r.socials,
          p_address: r.address,
          p_contact_forms: r.contactForms,
        })
        if (rpcErr) {
          console.error(`  ! lead ${row.lead_id}: ${rpcErr.message}`)
          continue
        }
      }
      stats.written++
    }

    console.log(
      `[backfill] scanned=${stats.scanned} written=${stats.written} skipV2=${stats.skippedV2} unproductive=${stats.unproductive}`,
    )
  }

  let seen = 0
  for await (const id of candidateLeadIds()) {
    if (seen >= LIMIT) break
    batch.push(id)
    seen++
    if (batch.length >= PAGE) await flush()
  }
  await flush()

  console.log('\n===== backfill complete =====')
  console.table(stats)
  if (DRY_RUN) console.log('(dry-run — no rows written)')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
