'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { shouldSkipDomain } from '@/lib/affiliate-detection/scorer'

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
//
// Enqueues into enrichment_fetch_queue with multi_page navigation
// turned on. The VM worker visits the homepage AND any contact-shaped
// pages (/contact, /about, /impressum) in one browser session, then
// the score-row endpoint runs the cascade:
//   regex → GPT-4o + web_search → Hunter.io
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
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code')
    .eq('scrape_job_id', jobId)
    .is('is_contact_overridden_at', null)
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
      process_stages: ['contact'],
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
    message: `Enqueued ${enqueueable.length} contact-extraction job${enqueueable.length === 1 ? '' : 's'}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}. VM workers will visit homepage + contact pages, then escalate to GPT-4o / Hunter.io if regex finds nothing.`,
  }
}

// ============================================================
// Epic 7.5 — S-Tag Extraction (only on affiliate rows)
//
// Enqueues into enrichment_fetch_queue with process_stages: ['stag'].
// The VM worker takes over from there, owning the Chromium for the
// full lifecycle: load homepage + casino-listing pages, three-path
// link extraction, browser-side redirect resolution per tracking
// link (so geo-routed redirects use the correct country profile),
// screenshot of each landing page, then ships the resolved tags to
// /api/enrichment/score-row which calls replace_and_verify_s_tags
// (auto-runs the dup-check + Rooster cross-reference inline).
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
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code, is_affiliate')
    .eq('scrape_job_id', jobId)
    .eq('is_affiliate', true)
    .is('is_stag_overridden_at', null)
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
      process_stages: ['stag'],
    })
  }

  if (enqueueable.length === 0) {
    revalidatePath(`/scrape/${jobId}`)
    return {
      status: 'ok',
      message:
        skippedCount > 0
          ? `${skippedCount} skipped — nothing else to enqueue.`
          : 'No affiliate rows to process — run affiliate detection first.',
    }
  }

  const { error: qErr } = await svc.from('enrichment_fetch_queue').insert(enqueueable)
  if (qErr) return { status: 'error', error: qErr.message }

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Enqueued ${enqueueable.length} s-tag job${enqueueable.length === 1 ? '' : 's'}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}. VM workers will crawl listing pages, follow tracking redirects in the country profile, and verify each tag against Monday.`,
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
