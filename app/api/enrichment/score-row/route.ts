import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { scoreAffiliate, shouldSkipDomain } from '@/lib/affiliate-detection/scorer'
import { findRoosterBrandLinks } from '@/lib/affiliate-detection/rooster'
import { extractContacts } from '@/lib/contact-extraction/extract'
import { findContactsWithOpenAI } from '@/lib/contact-extraction/llm-fallback'
import { findContactsWithHunter } from '@/lib/contact-extraction/hunter'
import { validatePhones } from '@/lib/contact-extraction/phone-validate'

export const dynamic = 'force-dynamic'

/**
 * Internal endpoint called by the VM enrichment workers right after they
 * write fetched HTML to fetched_html_cache. Does inline scoring for the
 * requested stage and writes results to google_lead_gen_table.
 *
 * Auth: Bearer token via INTERNAL_API_TOKEN env var (set on both Vercel
 * and the VM .env). This is NOT a user-facing endpoint.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization') ?? ''
  const expected = process.env.INTERNAL_API_TOKEN
  if (!expected) return NextResponse.json({ error: 'Server missing INTERNAL_API_TOKEN' }, { status: 500 })
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { lead_id?: number; stage?: string }
  try {
    body = (await req.json()) as { lead_id?: number; stage?: string }
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const leadId = Number(body.lead_id)
  const stage = String(body.stage ?? '').trim()
  if (!Number.isFinite(leadId)) return NextResponse.json({ error: 'lead_id missing' }, { status: 400 })
  if (!stage) return NextResponse.json({ error: 'stage missing' }, { status: 400 })

  const svc = createServiceClient()
  const { data: lead, error: leadErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code, result_type, is_contact_overridden_at')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'lead not found' }, { status: 404 })

  const { data: cache, error: cacheErr } = await svc
    .from('fetched_html_cache')
    .select('html, fetch_error')
    .eq('lead_id', leadId)
    .maybeSingle()
  if (cacheErr) return NextResponse.json({ error: cacheErr.message }, { status: 500 })

  const now = new Date().toISOString()
  const fetchError = cache?.fetch_error ?? null
  const html = cache?.html ?? ''
  const url = (lead as { url: string | null }).url ?? ''
  const domain = (lead as { domain: string | null }).domain ?? null
  const countryCode = (lead as { country_code: string | null }).country_code ?? null
  const contactOverridden =
    (lead as { is_contact_overridden_at: string | null }).is_contact_overridden_at !== null

  switch (stage) {
    case 'affiliate':
      return await scoreAffiliateStage()
    case 'rooster':
      return await scoreRoosterStage()
    case 'contact':
      return await scoreContactStage()
    default:
      return NextResponse.json(
        { ok: false, error: `Stage '${stage}' not yet wired through the enrichment queue.` },
        { status: 501 },
      )
  }

  // ----- inner handlers -----
  async function scoreAffiliateStage(): Promise<Response> {
    if (fetchError) {
      await svc
        .from('google_lead_gen_table')
        .update({
          is_affiliate: null,
          affiliate_confidence: 'ERROR',
          affiliate_indicators: [`Fetch failed: ${fetchError}`],
          affiliate_checked_at: now,
        })
        .eq('id', leadId)
      return NextResponse.json({ ok: true, status: 'fetch_error_recorded' })
    }
    if (shouldSkipDomain(domain)) {
      await svc
        .from('google_lead_gen_table')
        .update({
          is_affiliate: false,
          affiliate_score: 0,
          affiliate_casino_score: 0,
          affiliate_confidence: 'SKIPPED',
          affiliate_external_links: 0,
          affiliate_indicators: ['Skipped — known social/non-affiliate domain'],
          affiliate_checked_at: now,
        })
        .eq('id', leadId)
      return NextResponse.json({ ok: true, status: 'skipped' })
    }
    const result = scoreAffiliate(html, url)
    await svc
      .from('google_lead_gen_table')
      .update({
        is_affiliate: result.classification === 'AFFILIATE',
        affiliate_score: result.affiliateScore,
        affiliate_casino_score: result.casinoScore,
        affiliate_confidence: result.confidence,
        affiliate_external_links: result.externalCasinoLinks,
        affiliate_indicators: result.indicators,
        affiliate_checked_at: now,
      })
      .eq('id', leadId)
    return NextResponse.json({
      ok: true,
      classification: result.classification,
      confidence: result.confidence,
    })
  }

  async function scoreRoosterStage(): Promise<Response> {
    if (fetchError) {
      await svc
        .from('google_lead_gen_table')
        .update({
          is_rooster_partner: null,
          rooster_brands: null,
          rooster_checked_at: now,
        })
        .eq('id', leadId)
      return NextResponse.json({ ok: true, status: 'fetch_error_recorded' })
    }
    if (shouldSkipDomain(domain)) {
      await svc
        .from('google_lead_gen_table')
        .update({
          is_rooster_partner: false,
          brand: null,
          rooster_brands: null,
          rooster_checked_at: now,
        })
        .eq('id', leadId)
      return NextResponse.json({ ok: true, status: 'skipped' })
    }

    // Pull the active brand list fresh on every call so brand additions
    // / removals from /brands take effect immediately.
    const { data: brandRows, error: brandErr } = await svc.rpc('list_rooster_brand_domains')
    if (brandErr) return NextResponse.json({ error: brandErr.message }, { status: 500 })
    const brandList = (brandRows ?? []) as Array<{
      domain: string
      brand_name: string | null
      monday_item_id: string | null
    }>

    const matches = findRoosterBrandLinks(html, brandList)
    const isPartner = matches.length > 0
    await svc
      .from('google_lead_gen_table')
      .update({
        is_rooster_partner: isPartner,
        brand: matches[0]?.brand_name ?? null,
        rooster_brands: matches.length > 0 ? matches : null,
        rooster_checked_at: now,
      })
      .eq('id', leadId)

    return NextResponse.json({ ok: true, partner: isPartner, match_count: matches.length })
  }

  /**
   * Contact-extraction cascade (matches user-spec):
   *   1. Regex on the cached multi-page HTML (homepage + /contact etc.)
   *   2. If empty, escalate to GPT-4o + web_search
   *   3. If still empty, fall back to Hunter.io domain-search
   *   4. Validate any phone numbers via libphonenumber-js
   *   5. Persist via upsert_contact_for_lead RPC (preserves manual rows)
   */
  async function scoreContactStage(): Promise<Response> {
    if (contactOverridden) {
      return NextResponse.json({ ok: true, status: 'manually_overridden' })
    }

    if (fetchError) {
      // Even on fetch failure we still try the LLM + Hunter — they can find
      // contacts from public sources independent of the lead's site.
      const tier = await runLlmThenHunter()
      await persistContact(tier)
      return NextResponse.json({ ok: true, ...tier.summary })
    }

    if (shouldSkipDomain(domain)) {
      await svc
        .from('google_lead_gen_table')
        .update({ has_contact_details: false, contact_checked_at: now })
        .eq('id', leadId)
      return NextResponse.json({ ok: true, status: 'skipped' })
    }

    // Tier 1 — regex on the multi-page HTML
    const regex = extractContacts(html, url)
    let emails = regex.emails
    let phones = regex.phones
    let contactPageUrl = regex.contactPageUrl
    let source: 'regex' | 'multi_page' | 'openai' | 'hunter' = 'regex'
    let raw: Record<string, unknown> = { regex: regex.raw }
    // The HTML blob from the worker has page-break markers when multi_page
    // was on. Detect that and tag the source accordingly so the audit trail
    // shows whether we read more than just the homepage.
    if (html.includes('<!-- PAGE: ')) source = 'multi_page'

    const tier1Productive = emails.length > 0 || phones.length > 0 || contactPageUrl !== null

    if (!tier1Productive) {
      // Tier 2 — OpenAI + web_search
      const llm = await findContactsWithOpenAI(domain ?? '', url)
      if (llm) {
        emails = llm.emails
        phones = llm.phones
        contactPageUrl = llm.contactPageUrl ?? contactPageUrl
        source = 'openai'
        raw = { ...raw, openai: { reasoning: llm.reasoning } }
      }

      // Tier 3 — Hunter.io (only if LLM still produced no emails)
      if (emails.length === 0) {
        const hunter = await findContactsWithHunter(domain ?? '')
        if (hunter && hunter.emails.length > 0) {
          emails = hunter.emails
          source = 'hunter'
          raw = { ...raw, hunter: hunter.raw }
        }
      }
    }

    // Tier 4 — phone validation (drops false positives, normalises format)
    phones = validatePhones(phones, countryCode)

    await svc.rpc('upsert_contact_for_lead', {
      p_lead_id: leadId,
      p_emails: emails,
      p_phones: phones,
      p_contact_page_url: contactPageUrl,
      p_source: source,
      p_raw: raw,
    })

    return NextResponse.json({
      ok: true,
      source,
      emails: emails.length,
      phones: phones.length,
      contact_page: contactPageUrl !== null,
    })

    async function runLlmThenHunter() {
      let emails: string[] = []
      let phones: string[] = []
      let contactPageUrl: string | null = null
      let source: 'openai' | 'hunter' | 'regex' = 'regex'
      const raw: Record<string, unknown> = { fetch_error: fetchError }

      const llm = await findContactsWithOpenAI(domain ?? '', url)
      if (llm) {
        emails = llm.emails
        phones = llm.phones
        contactPageUrl = llm.contactPageUrl
        source = 'openai'
        raw.openai = { reasoning: llm.reasoning }
      }
      if (emails.length === 0) {
        const hunter = await findContactsWithHunter(domain ?? '')
        if (hunter && hunter.emails.length > 0) {
          emails = hunter.emails
          source = 'hunter'
          raw.hunter = hunter.raw
        }
      }
      return {
        summary: { source, emails: emails.length, phones: phones.length },
        emails,
        phones: validatePhones(phones, countryCode),
        contactPageUrl,
        source,
        raw,
      }
    }

    async function persistContact(tier: {
      emails: string[]
      phones: string[]
      contactPageUrl: string | null
      source: 'openai' | 'hunter' | 'regex' | 'multi_page'
      raw: Record<string, unknown>
    }) {
      await svc.rpc('upsert_contact_for_lead', {
        p_lead_id: leadId,
        p_emails: tier.emails,
        p_phones: tier.phones,
        p_contact_page_url: tier.contactPageUrl,
        p_source: tier.source,
        p_raw: tier.raw,
      })
    }
  }
}
