'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { fetchHtml, runWithConcurrency } from '@/lib/affiliate-detection/fetch'
import { scoreAffiliate, shouldSkipDomain } from '@/lib/affiliate-detection/scorer'
import { findRoosterBrandLinks } from '@/lib/affiliate-detection/rooster'
import { extractContacts } from '@/lib/contact-extraction/extract'
import { extractStagsFromHtml } from '@/lib/stag-extraction/extract'

const STAGE_FETCH_CONCURRENCY = 5

export type EnqueueState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export type CheckMondayState =
  | { status: 'ok'; message: string; checked: number; matched: number }
  | { status: 'error'; error: string }
  | null

export async function checkMondayDuplicates(
  _prev: CheckMondayState,
  formData: FormData,
): Promise<CheckMondayState> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const jobId = String(formData.get('job_id') ?? '').trim()
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('mark_monday_duplicates_for_job', {
    p_job_id: jobId,
  })
  if (error) return { status: 'error', error: error.message }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { checked: number; matched: number }
    | null
  const checked = row?.checked ?? 0
  const matched = row?.matched ?? 0

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    checked,
    matched,
    message:
      checked === 0
        ? 'No rows to check yet.'
        : matched === 0
          ? `Checked ${checked} row${checked === 1 ? '' : 's'} — none already on Monday.`
          : `Checked ${checked} row${checked === 1 ? '' : 's'} — ${matched} already on Monday.`,
  }
}

export async function enqueueScrape(
  _prev: EnqueueState,
  formData: FormData,
): Promise<EnqueueState> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const rawKeywords = String(formData.get('keyword') ?? '')
  const country_code = String(formData.get('country_code') ?? '').trim().toUpperCase()
  const pages = clampInt(formData.get('pages'), 1, 10, 1)
  const priority = clampInt(formData.get('priority'), 0, 100, 0)

  // Parse the textarea — one keyword per line, trim whitespace,
  // dedupe exact duplicates, drop blanks.
  const keywords = Array.from(
    new Set(
      rawKeywords
        .split(/\r?\n/)
        .map(k => k.trim())
        .filter(k => k.length > 0),
    ),
  )

  if (keywords.length === 0) return { status: 'error', error: 'Enter at least one keyword.' }
  const tooLong = keywords.find(k => k.length > 500)
  if (tooLong) {
    return {
      status: 'error',
      error: `One of the keywords is too long (max 500 chars): "${tooLong.slice(0, 50)}…"`,
    }
  }
  if (!country_code) return { status: 'error', error: 'Pick a country.' }

  const svc = createServiceClient()

  // Verify the country has a configured GoLogin profile
  const { data: profile, error: profileError } = await svc
    .from('gologin_profiles')
    .select('country_code, is_active, gologin_profile_id')
    .eq('country_code', country_code)
    .maybeSingle()
  if (profileError) return { status: 'error', error: profileError.message }
  if (!profile) return { status: 'error', error: `Unknown country ${country_code}.` }
  if (!profile.is_active) return { status: 'error', error: `Country ${country_code} is disabled.` }
  if (!profile.gologin_profile_id) {
    return { status: 'error', error: `Country ${country_code} has no GoLogin profile configured.` }
  }

  const rows = keywords.map(keyword => ({ keyword, country_code, pages, priority }))
  const { error: insertError } = await svc.from('scrape_queue').insert(rows)
  if (insertError) return { status: 'error', error: insertError.message }

  revalidatePath('/scrape')
  return {
    status: 'ok',
    message:
      keywords.length === 1
        ? `Added "${keywords[0]}" to the queue for ${country_code}.`
        : `Added ${keywords.length} keywords to the queue for ${country_code}.`,
  }
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

// ============================================================
// Epic 7.2 — Affiliate Detection
// ============================================================
export type StageRunState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

async function requireSignedIn(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }
  return { ok: true }
}

function jobIdFrom(fd: FormData): string {
  return String(fd.get('job_id') ?? '').trim()
}

type LeadForFetch = {
  id: number
  url: string | null
  domain: string | null
  is_affiliate: boolean | null
}

async function fetchLeadsForStage(
  jobId: string,
  selectCols: string,
  overrideColumn: string,
): Promise<LeadForFetch[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select(selectCols)
    .eq('scrape_job_id', jobId)
    .is(overrideColumn, null)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as LeadForFetch[]
}

export async function runAffiliateDetection(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const leads = await fetchLeadsForStage(
    jobId,
    'id, url, domain, is_affiliate',
    'is_affiliate_overridden_at',
  )

  let affiliateCount = 0
  let errorCount = 0
  let skippedCount = 0

  await runWithConcurrency(leads, STAGE_FETCH_CONCURRENCY, async lead => {
    const url = lead.url ?? ''
    if (!url || !url.startsWith('http')) {
      skippedCount++
      return
    }
    if (shouldSkipDomain(lead.domain)) {
      await svc
        .from('google_lead_gen_table')
        .update({
          is_affiliate: false,
          affiliate_score: 0,
          affiliate_casino_score: 0,
          affiliate_confidence: 'SKIPPED',
          affiliate_external_links: 0,
          affiliate_indicators: ['Skipped — known social/non-affiliate domain'],
          affiliate_checked_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
      skippedCount++
      return
    }

    const fetched = await fetchHtml(url)
    if (!fetched.ok) {
      await svc
        .from('google_lead_gen_table')
        .update({
          is_affiliate: null,
          affiliate_confidence: 'ERROR',
          affiliate_indicators: [`Fetch failed: ${fetched.error}`],
          affiliate_checked_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
      errorCount++
      return
    }

    const result = scoreAffiliate(fetched.html, fetched.finalUrl)
    const isAffiliate = result.classification === 'AFFILIATE'
    if (isAffiliate) affiliateCount++
    await svc
      .from('google_lead_gen_table')
      .update({
        is_affiliate: isAffiliate,
        affiliate_score: result.affiliateScore,
        affiliate_casino_score: result.casinoScore,
        affiliate_confidence: result.confidence,
        affiliate_external_links: result.externalCasinoLinks,
        affiliate_indicators: result.indicators,
        affiliate_checked_at: new Date().toISOString(),
      })
      .eq('id', lead.id)
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Checked ${leads.length} row${leads.length === 1 ? '' : 's'} — ${affiliateCount} classified as affiliate, ${errorCount} fetch failed, ${skippedCount} skipped.`,
  }
}

// ============================================================
// Epic 7.3 — Rooster Partner Brand Check
// ============================================================
export async function runRoosterCheck(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data: brandRows, error: brandErr } = await svc.rpc('list_rooster_brand_domains')
  if (brandErr) return { status: 'error', error: `Loading brand list failed: ${brandErr.message}` }
  const brandList = (brandRows ?? []) as Array<{
    domain: string
    brand_name: string | null
    monday_item_id: string | null
  }>

  const leads = await fetchLeadsForStage(
    jobId,
    'id, url, domain, is_affiliate',
    'is_rooster_overridden_at',
  )

  let matchCount = 0
  let errorCount = 0

  await runWithConcurrency(leads, STAGE_FETCH_CONCURRENCY, async lead => {
    const url = lead.url ?? ''
    if (!url || !url.startsWith('http') || shouldSkipDomain(lead.domain)) return

    const fetched = await fetchHtml(url)
    if (!fetched.ok) {
      errorCount++
      return
    }
    const matches = findRoosterBrandLinks(fetched.html, brandList)
    const isPartner = matches.length > 0
    if (isPartner) matchCount++
    await svc
      .from('google_lead_gen_table')
      .update({
        is_rooster_partner: isPartner,
        brand: matches[0]?.brand_name ?? null,
        rooster_brands: matches.length > 0 ? matches : null,
        rooster_checked_at: new Date().toISOString(),
      })
      .eq('id', lead.id)
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Checked ${leads.length} row${leads.length === 1 ? '' : 's'} — ${matchCount} promote a Rooster brand, ${errorCount} fetch failed.`,
  }
}

// ============================================================
// Epic 7.4 — Contact Extraction
// ============================================================
export async function runContactExtraction(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const leads = await fetchLeadsForStage(
    jobId,
    'id, url, domain, is_affiliate',
    'is_contact_overridden_at',
  )

  let contactCount = 0
  let errorCount = 0

  await runWithConcurrency(leads, STAGE_FETCH_CONCURRENCY, async lead => {
    const url = lead.url ?? ''
    if (!url || !url.startsWith('http')) return

    const fetched = await fetchHtml(url)
    if (!fetched.ok) {
      errorCount++
      return
    }
    const result = extractContacts(fetched.html, fetched.finalUrl)
    const found =
      result.emails.length > 0 ||
      result.phones.length > 0 ||
      (result.contactPageUrl ?? '') !== ''
    if (found) contactCount++

    await svc.rpc('upsert_contact_for_lead', {
      p_lead_id: lead.id,
      p_emails: result.emails,
      p_phones: result.phones,
      p_contact_page_url: result.contactPageUrl,
      p_source: 'regex',
      p_raw: result.raw,
    })
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Checked ${leads.length} row${leads.length === 1 ? '' : 's'} — ${contactCount} with contact details, ${errorCount} fetch failed.`,
  }
}

// ============================================================
// Epic 7.5 — S-Tag Extraction (only on affiliate rows)
// ============================================================
export async function runStagExtraction(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, is_affiliate')
    .eq('scrape_job_id', jobId)
    .eq('is_affiliate', true)
    .is('is_stag_overridden_at', null)
  if (error) return { status: 'error', error: error.message }
  const leads = (data ?? []) as LeadForFetch[]

  let totalTags = 0
  let leadsWithTags = 0
  let errorCount = 0

  await runWithConcurrency(leads, STAGE_FETCH_CONCURRENCY, async lead => {
    const url = lead.url ?? ''
    if (!url || !url.startsWith('http')) return

    const fetched = await fetchHtml(url)
    if (!fetched.ok) {
      errorCount++
      return
    }
    const tags = await extractStagsFromHtml(fetched.html, fetched.finalUrl)
    if (tags.length > 0) {
      leadsWithTags++
      totalTags += tags.length
    }
    await svc.rpc('replace_s_tags_for_lead', {
      p_lead_id: lead.id,
      p_tags: tags,
    })
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      leads.length === 0
        ? 'No affiliate rows yet — run affiliate detection first.'
        : `Processed ${leads.length} affiliate row${leads.length === 1 ? '' : 's'} — found ${totalTags} s-tag${totalTags === 1 ? '' : 's'} across ${leadsWithTags} lead${leadsWithTags === 1 ? '' : 's'}, ${errorCount} fetch failed.`,
  }
}

// ============================================================
// Epic 7.6 — S-Tag Duplicate Check (Monday mirror)
// ============================================================
export async function runStagDuplicateCheck(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('mark_s_tag_duplicates_for_job', {
    p_job_id: jobId,
  })
  if (error) return { status: 'error', error: error.message }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { checked: number; matched: number }
    | null
  const checked = row?.checked ?? 0
  const matched = row?.matched ?? 0

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      checked === 0
        ? 'No s-tags to check — run S-tag extraction first.'
        : `Checked ${checked} s-tag${checked === 1 ? '' : 's'} — ${matched} already on Monday.`,
  }
}
