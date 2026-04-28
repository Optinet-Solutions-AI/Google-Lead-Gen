'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { fetchHtml, runWithConcurrency } from '@/lib/affiliate-detection/fetch'
import { shouldSkipDomain } from '@/lib/affiliate-detection/scorer'
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
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code, result_type')
    .eq('scrape_job_id', jobId)
    .is('is_affiliate_overridden_at', null)
  if (leadsErr) return { status: 'error', error: leadsErr.message }

  // Pre-flag SKIPPED rows synchronously (cheap, no fetch needed) so the
  // enqueue stays focused on rows that genuinely need a browser fetch.
  let skippedCount = 0
  const enqueueable: Array<{
    lead_id: number
    country_code: string
    url: string
    want_html: boolean
    want_screenshot: boolean
    process_stages: string[]
  }> = []
  const now = new Date().toISOString()
  for (const lead of (leads ?? []) as Array<{
    id: number
    url: string | null
    domain: string | null
    country_code: string | null
    result_type: string | null
  }>) {
    const url = lead.url ?? ''
    if (!url || !url.startsWith('http')) continue
    if (!lead.country_code) continue
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
          affiliate_checked_at: now,
        })
        .eq('id', lead.id)
      skippedCount++
      continue
    }
    enqueueable.push({
      lead_id: lead.id,
      country_code: lead.country_code,
      url,
      want_html: true,
      // Per user policy: PPC rows always get a screenshot for verification.
      want_screenshot: lead.result_type === 'PPC',
      process_stages: ['affiliate'],
    })
  }

  if (enqueueable.length === 0) {
    revalidatePath(`/scrape/${jobId}`)
    return {
      status: 'ok',
      message: skippedCount > 0
        ? `${skippedCount} skipped — nothing else to enqueue.`
        : 'No leads to process.',
    }
  }

  const { error: qErr } = await svc.from('enrichment_fetch_queue').insert(enqueueable)
  if (qErr) return { status: 'error', error: qErr.message }

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Enqueued ${enqueueable.length} fetch job${enqueueable.length === 1 ? '' : 's'}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}. VM workers will process and score them within ~30 s.`,
  }
}

// ============================================================
// Epic 7.3 — Rooster Partner Brand Check
//
// Routed through the VM enrichment queue (same as affiliate). The
// VM worker fetches HTML through GoLogin (real browser, real
// proxy), writes to fetched_html_cache, then calls the score-row
// API with stage='rooster' which reads the cache + the active
// rooster_brands list and writes results back to the lead.
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
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code, result_type')
    .eq('scrape_job_id', jobId)
    .is('is_rooster_overridden_at', null)
  if (leadsErr) return { status: 'error', error: leadsErr.message }

  let skippedCount = 0
  const enqueueable: Array<{
    lead_id: number
    country_code: string
    url: string
    want_html: boolean
    want_screenshot: boolean
    process_stages: string[]
  }> = []
  for (const lead of (leads ?? []) as Array<{
    id: number
    url: string | null
    domain: string | null
    country_code: string | null
    result_type: string | null
  }>) {
    const url = lead.url ?? ''
    if (!url || !url.startsWith('http')) continue
    if (!lead.country_code) continue
    if (shouldSkipDomain(lead.domain)) {
      skippedCount++
      continue
    }
    enqueueable.push({
      lead_id: lead.id,
      country_code: lead.country_code,
      url,
      want_html: true,
      want_screenshot: false,
      process_stages: ['rooster'],
    })
  }

  if (enqueueable.length === 0) {
    revalidatePath(`/scrape/${jobId}`)
    return {
      status: 'ok',
      message: skippedCount > 0
        ? `${skippedCount} skipped — nothing else to enqueue.`
        : 'No leads to process.',
    }
  }

  const { error: qErr } = await svc.from('enrichment_fetch_queue').insert(enqueueable)
  if (qErr) return { status: 'error', error: qErr.message }

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Enqueued ${enqueueable.length} fetch job${enqueueable.length === 1 ? '' : 's'}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}. VM workers will check brand mentions within ~30 s.`,
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
