/**
 * LGP-208 (paid pass) — OpenAI + Hunter.io backfill for affiliates that
 * STILL have no reachable contact after the free Tier-1 backfill.
 *
 * Mirrors the score-row route's Tier 2/3 cascade: GPT-4o + web_search,
 * then Hunter.io domain-search if the LLM found no emails. Persists via
 * upsert_contact_for_lead_v2 with per-item provenance (method openai /
 * hunter). Phones normalised through the shared validator.
 *
 * COSTS REAL MONEY. Guard rails:
 *   - Default is a DRY-RUN scope report (counts leads + cost estimate,
 *     calls NOTHING). You must pass --run to actually spend.
 *   - --limit=N caps how many leads are processed (default 50 on a live
 *     run — you have to opt into a bigger number explicitly).
 *   - Requires OPENAI_API_KEY and HUNTER_API_KEY in the env.
 *
 *   npx tsx scripts/qa/_contact-backfill-paid.ts               # scope + estimate only
 *   npx tsx scripts/qa/_contact-backfill-paid.ts --run --limit=50
 *   npx tsx scripts/qa/_contact-backfill-paid.ts --run --limit=5000
 *
 * Target set: is_affiliate = true, has_contact_details = false. By default
 * only leads already run through extraction (contact_checked_at not null)
 * — i.e. Tier 1 genuinely found nothing. Pass --include-unchecked to also
 * take affiliates never checked at all.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { findContactsWithOpenAI } from '../../lib/contact-extraction/llm-fallback'
import { findContactsWithHunter } from '../../lib/contact-extraction/hunter'
import { validatePhones } from '../../lib/contact-extraction/phone-validate'
import type { ContactItem } from '../../lib/contact-extraction/extract'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const argv = process.argv.slice(2)
const RUN = argv.includes('--run')
const INCLUDE_UNCHECKED = argv.includes('--include-unchecked')
const limitArg = argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]!, 10) : RUN ? 50 : Infinity
// Rough per-lead cost for the scope estimate (GPT-4o + web_search call,
// occasionally a Hunter lookup). Ballpark only — for planning, not billing.
const EST_COST_PER_LEAD_USD = 0.04
const CONCURRENCY = 3
const PAGE = 500

type Lead = { id: number; url: string | null; domain: string | null; country_code: string | null }

function baseSelect() {
  let q = s
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code')
    .eq('is_affiliate', true)
    .eq('has_contact_details', false)
  if (!INCLUDE_UNCHECKED) q = q.not('contact_checked_at', 'is', null)
  return q
}

async function countTargets(): Promise<number> {
  let q = s
    .from('google_lead_gen_table')
    .select('id', { count: 'exact', head: true })
    .eq('is_affiliate', true)
    .eq('has_contact_details', false)
  if (!INCLUDE_UNCHECKED) q = q.not('contact_checked_at', 'is', null)
  const { count, error } = await q
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function* targets(): AsyncGenerator<Lead> {
  let after = 0
  let yielded = 0
  for (;;) {
    const { data, error } = await baseSelect()
      .gt('id', after)
      .order('id', { ascending: true })
      .limit(PAGE)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) return
    for (const row of data as Lead[]) {
      yield row
      if (++yielded >= LIMIT) return
    }
    after = (data[data.length - 1] as Lead).id
    if (data.length < PAGE) return
  }
}

async function processLead(lead: Lead, stats: Stats): Promise<void> {
  const domain = lead.domain ?? ''
  const url = lead.url ?? (domain ? `https://${domain}` : '')
  if (!domain && !url) {
    stats.skipped++
    return
  }

  let emails: string[] = []
  let phones: string[] = []
  let contactPageUrl: string | null = null
  let source: 'openai' | 'hunter' | 'regex' = 'regex'
  const raw: Record<string, unknown> = { paid_backfill: true }
  const items: ContactItem[] = []

  const llm = await findContactsWithOpenAI(domain, url)
  if (llm) {
    emails = llm.emails
    phones = llm.phones
    contactPageUrl = llm.contactPageUrl
    source = 'openai'
    raw.openai = { reasoning: llm.reasoning }
    const via = llm.contactPageUrl ?? url
    for (const e of llm.emails) items.push({ kind: 'email', value: e, method: 'openai', sourceUrl: via, confidence: 0.5 })
    for (const p of llm.phones) items.push({ kind: 'phone', value: p, method: 'openai', sourceUrl: via, confidence: 0.5 })
  }
  if (emails.length === 0) {
    const hunter = await findContactsWithHunter(domain)
    if (hunter && hunter.emails.length > 0) {
      emails = hunter.emails
      source = 'hunter'
      raw.hunter = hunter.raw
      for (const e of hunter.emails) {
        const conf = hunter.confidenceByEmail?.[e]
        items.push({ kind: 'email', value: e, method: 'hunter', sourceUrl: `https://${domain}`, confidence: typeof conf === 'number' ? conf / 100 : 0.4, label: 'hunter.io' })
      }
    }
  }

  phones = validatePhones(phones, lead.country_code)

  const productive = emails.length > 0 || phones.length > 0 || contactPageUrl !== null
  if (!productive) {
    stats.noContact++
    return
  }

  const { error } = await s.rpc('upsert_contact_for_lead_v2', {
    p_lead_id: lead.id,
    p_emails: emails,
    p_phones: phones,
    p_contact_page_url: contactPageUrl,
    p_source: source,
    p_raw: raw,
    p_items: items,
    p_socials: [],
    p_address: null,
    p_contact_forms: [],
  })
  if (error) {
    console.error(`  ! lead ${lead.id}: ${error.message}`)
    stats.errors++
    return
  }
  stats.written++
  if (source === 'openai') stats.viaOpenai++
  if (source === 'hunter') stats.viaHunter++
  stats.emails += emails.length
  stats.phones += phones.length
}

type Stats = {
  processed: number
  written: number
  viaOpenai: number
  viaHunter: number
  noContact: number
  skipped: number
  errors: number
  emails: number
  phones: number
}

async function main() {
  const haveKeys = !!process.env.OPENAI_API_KEY && !!process.env.HUNTER_API_KEY
  const total = await countTargets()
  console.log(
    `[paid-backfill] target affiliates (is_affiliate, no contact${INCLUDE_UNCHECKED ? '' : ', already checked'}): ${total.toLocaleString()}`,
  )

  if (!RUN) {
    const scope = Math.min(total, LIMIT === Infinity ? total : LIMIT)
    console.log(`\n=== DRY-RUN (no calls made) ===`)
    console.log(`Would process:        ${scope.toLocaleString()} leads`)
    console.log(`Rough cost estimate:  ~$${(scope * EST_COST_PER_LEAD_USD).toFixed(2)} (@ ~$${EST_COST_PER_LEAD_USD}/lead, ballpark)`)
    console.log(`OpenAI key present:   ${!!process.env.OPENAI_API_KEY}`)
    console.log(`Hunter key present:   ${!!process.env.HUNTER_API_KEY}`)
    console.log(`\nTo actually run:  npx tsx scripts/qa/_contact-backfill-paid.ts --run --limit=${Math.min(scope, 200)}`)
    return
  }

  if (!haveKeys) {
    console.error(
      '\n✗ OPENAI_API_KEY and/or HUNTER_API_KEY missing from the environment. Add them to .env.local before a live run.',
    )
    process.exit(1)
  }

  console.log(`\n=== LIVE RUN — limit=${LIMIT} concurrency=${CONCURRENCY} ===`)
  const stats: Stats = { processed: 0, written: 0, viaOpenai: 0, viaHunter: 0, noContact: 0, skipped: 0, errors: 0, emails: 0, phones: 0 }

  // Bounded-concurrency worker pool over the async generator.
  const gen = targets()
  async function worker() {
    for (;;) {
      const { value, done } = await gen.next()
      if (done) return
      await processLead(value, stats)
      stats.processed++
      if (stats.processed % 20 === 0) {
        console.log(`  processed=${stats.processed} written=${stats.written} (openai=${stats.viaOpenai} hunter=${stats.viaHunter}) noContact=${stats.noContact}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  console.log('\n===== paid backfill complete =====')
  console.table(stats)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
