import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { scoreAffiliate, shouldSkipDomain } from '@/lib/affiliate-detection/scorer'
import { findRoosterBrandLinks } from '@/lib/affiliate-detection/rooster'

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
    .select('id, url, domain, country_code, result_type')
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

  switch (stage) {
    case 'affiliate':
      return await scoreAffiliateStage()
    case 'rooster':
      return await scoreRoosterStage()
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
}
