'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { shouldSkipDomain } from '@/lib/affiliate-detection/scorer'
import { logActivity } from '@/lib/activity-log'
import { verifyUserPassword } from '@/lib/auth/verify-password'
import { translateKeywordsToEnglish } from '@/lib/translate'

// Log the raw Supabase error server-side, hand the user a generic message.
// Direct copy of the helper in leads/actions.ts (BUGS.md R2-16). Keeps
// schema names, constraint names, and column names out of the Next.js
// error boundary and client-bound action state.
function safeError(err: unknown, fallback: string): string {
  console.error('[scrape/actions]', err)
  return fallback
}

export type EnqueueState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export type CheckMondayState =
  | { status: 'ok'; message: string; checked: number; matched: number }
  | { status: 'error'; error: string }
  | null

// Monday duplicate check is the one per-job action that's intentionally
// open to all signed-in users (not just the job owner / admins). The RPC
// `mark_monday_duplicates_for_job` is idempotent, only touches the
// informational `is_on_monday` / `monday_board` / `monday_item_id`
// columns on this job's leads, and never enqueues scraper or proxy
// work — so cross-user use is safe. QA reported the strict ownership
// gate (R2 hardening) was blocking testers from re-running the check on
// jobs they didn't queue.
export async function checkMondayDuplicates(
  _prev: CheckMondayState,
  formData: FormData,
): Promise<CheckMondayState> {
  const jobId = String(formData.get('job_id') ?? '').trim()
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: jobExists, error: jobErr } = await svc
    .from('scrape_queue')
    .select('id')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to look up job.') }
  if (!jobExists) return { status: 'error', error: 'Job not found.' }

  const { data, error } = await svc.rpc('mark_monday_duplicates_for_job', {
    p_job_id: jobId,
  })
  if (error) return { status: 'error', error: safeError(error, 'Failed to check Monday duplicates.') }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { checked: number; matched: number }
    | null
  const checked = row?.checked ?? 0
  const matched = row?.matched ?? 0

  await logActivity({
    action: 'enrichment.monday_dup_check',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { checked, matched },
  })

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
  const withEnrichment = formData.get('with_enrichment') === 'on'
  const languageRaw = String(formData.get('language') ?? '').trim().toLowerCase()
  // Allow only 2-letter ISO 639-1 codes; default to English.
  const language = /^[a-z]{2}$/.test(languageRaw) ? languageRaw : 'en'
  const engineRaw = String(formData.get('search_engine') ?? '').trim().toLowerCase()
  // The form lets the user pick a single engine OR "both" — the latter
  // fans out to two queue rows per keyword (one Google, one Bing).
  // 'youtube' is a separate path (Data API, channel results into
  // youtube_channels) and intentionally NOT included in "both" — the
  // output shape is too different to bundle into a SERP comparison.
  const enginesToRun: Array<'google' | 'bing' | 'youtube'> =
    engineRaw === 'both'
      ? ['google', 'bing']
      : engineRaw === 'bing'
        ? ['bing']
        : engineRaw === 'youtube'
          ? ['youtube']
          : ['google']
  // view_mode controls whether the scraper runs desktop, mobile (iPhone
  // UA + 375x812 viewport via CDP), or both passes. 'both' is the
  // default — catches mobile-only PPC ads + mobile-ranked organic that
  // desktop misses. Validated against the DB check constraint so a
  // hand-crafted POST can't slip in an unknown value.
  const viewModeRaw = String(formData.get('view_mode') ?? 'both').trim().toLowerCase()
  const viewMode: 'desktop' | 'mobile' | 'both' =
    viewModeRaw === 'desktop' || viewModeRaw === 'mobile' ? viewModeRaw : 'both'
  const scheduledAtRaw = String(formData.get('scheduled_at') ?? '').trim()
  let scheduledAtIso: string | null = null
  if (scheduledAtRaw) {
    const d = new Date(scheduledAtRaw)
    if (Number.isFinite(d.getTime())) {
      scheduledAtIso = d.toISOString()
    }
  }

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
  // Cap per-submit volume so a 10k-keyword paste can't flood scrape_queue
  // in a single round-trip (and 2× when engine=both). 200 is well above
  // any realistic batch but well below "DoS the workers" territory.
  if (keywords.length > 200) {
    return {
      status: 'error',
      error: `Too many keywords in one submit (${keywords.length}); max 200 per batch.`,
    }
  }
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
    .select('country_code, is_active, gologin_profile_id, languages')
    .eq('country_code', country_code)
    .maybeSingle()
  if (profileError) return { status: 'error', error: safeError(profileError, 'Failed to load country profile.') }
  if (!profile) return { status: 'error', error: `Unknown country ${country_code}.` }
  if (!profile.is_active) return { status: 'error', error: `Country ${country_code} is disabled.` }
  if (!profile.gologin_profile_id) {
    return { status: 'error', error: `Country ${country_code} has no GoLogin profile configured.` }
  }
  // Reject a language that isn't valid for this country (UI filters but
  // a hand-crafted POST could still slip through). Falls back to the
  // first allowed language if the requested one isn't on the list.
  const allowedLangs = (profile as { languages: string[] | null }).languages ?? ['en']
  const finalLang = allowedLangs.includes(language) ? language : (allowedLangs[0] ?? 'en')

  // Cross-product: one row per (keyword × engine). Stamp queueing
  // attribution so /scrape can show "by <name>" without a join, and
  // so audit trails survive even if the user is later deleted from
  // auth.users.
  //
  // We denormalize three fields:
  //   - created_by_email     → audit identity (Supabase email)
  //   - created_by_username  → login username (lowercase)
  //   - created_by_display   → friendly label, falls back to username
  // Username + display come from user_profiles. If the row doesn't
  // exist for some reason, we fall back to email's local-part.
  const createdByEmail = user.email ?? null
  const { data: userProfileRow } = await svc
    .from('user_profiles')
    .select('username, display_name')
    .eq('id', user.id)
    .maybeSingle()
  const userProfile = userProfileRow as
    | { username: string | null; display_name: string | null }
    | null
  const fallbackUser = createdByEmail ? createdByEmail.split('@')[0] ?? null : null
  const createdByUsername = userProfile?.username ?? fallbackUser
  const createdByDisplay = userProfile?.display_name ?? createdByUsername

  // Translate non-English keywords to English so the detail-page
  // header and QA reviewers can read what's being scraped. Best-effort:
  // a missing API key or a Translate API failure returns an empty map
  // and the rows just get keyword_en = null. Never blocks the enqueue.
  const translations =
    finalLang === 'en'
      ? new Map<string, string>()
      : await translateKeywordsToEnglish(keywords, finalLang)

  const rows = keywords.flatMap(keyword =>
    enginesToRun.map(engine => ({
      keyword,
      keyword_en: translations.get(keyword) ?? null,
      country_code,
      pages,
      priority,
      with_enrichment: withEnrichment,
      scheduled_at: scheduledAtIso,
      language: finalLang,
      search_engine: engine,
      view_mode: viewMode,
      created_by_email: createdByEmail,
      created_by_username: createdByUsername,
      created_by_display: createdByDisplay,
    })),
  )
  const { error: insertError } = await svc.from('scrape_queue').insert(rows)
  if (insertError) return { status: 'error', error: safeError(insertError, 'Failed to queue the scrape.') }

  const flag = withEnrichment ? ' with full enrichment pipeline' : ''
  const when = scheduledAtIso
    ? ` to run at ${new Date(scheduledAtIso).toLocaleString()}`
    : ''
  const engineDescription =
    enginesToRun.length === 2
      ? ' on Google + Bing'
      : enginesToRun[0] === 'bing'
        ? ' on Bing'
        : enginesToRun[0] === 'youtube'
          ? ' on YouTube'
          : ''

  await logActivity({
    action: 'scrape.enqueue',
    entity_type: 'scrape_batch',
    details: {
      keywords_count: keywords.length,
      country_code,
      pages,
      priority,
      with_enrichment: withEnrichment,
      scheduled_at: scheduledAtIso,
      language: finalLang,
      engines: enginesToRun,
      rows_inserted: rows.length,
    },
  })

  revalidatePath('/scrape')
  const rowsLabel =
    enginesToRun.length === 2
      ? ` (${rows.length} jobs total — one per keyword per engine)`
      : ''
  return {
    status: 'ok',
    message:
      keywords.length === 1
        ? `Added "${keywords[0]}" to the queue for ${country_code}${engineDescription}${flag}${when}${rowsLabel}.`
        : `Added ${keywords.length} keyword${keywords.length === 1 ? '' : 's'} to the queue for ${country_code}${engineDescription}${flag}${when}${rowsLabel}.`,
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

/**
 * Authorise a per-job action: the caller must either own the job
 * (matched on `created_by_email`) or be an admin. Most per-job
 * actions in this file route through this — previously several
 * only checked "is the caller signed in" (BUGS.md #27, R2-1..R2-5),
 * leaving any signed-in user able to mutate any job_id they guessed.
 *
 * Carve-out: `checkMondayDuplicates` deliberately does NOT call this.
 * That action is idempotent, only writes informational `is_on_monday`
 * flags, and never enqueues scraper work — so QA testers need to run
 * it on jobs they don't own. See the comment on that function.
 */
async function requireJobAccess(
  jobId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('created_by_email')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { ok: false, error: safeError(jobErr, 'Failed to look up job ownership.') }
  if (!job) return { ok: false, error: 'Job not found.' }

  const ownerEmail = (job as { created_by_email: string | null }).created_by_email
  if (ownerEmail && user.email && ownerEmail.toLowerCase() === user.email.toLowerCase()) {
    return { ok: true }
  }
  const { data: isAdmin, error: adminErr } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (adminErr) return { ok: false, error: safeError(adminErr, 'Failed to verify admin access.') }
  if (isAdmin) return { ok: true }
  return { ok: false, error: 'You do not have access to this job.' }
}

function jobIdFrom(fd: FormData): string {
  return String(fd.get('job_id') ?? '').trim()
}


export async function runAffiliateDetection(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code, result_type, monday_board')
    .eq('scrape_job_id', jobId)
    .is('is_affiliate_overridden_at', null)
  if (leadsErr) return { status: 'error', error: safeError(leadsErr, 'Failed to load leads for this job.') }

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
    monday_board: string | null
  }>) {
    const url = lead.url ?? ''
    if (!url || !url.startsWith('http')) continue
    if (!lead.country_code) continue
    // Already classified on Monday's Affiliates board — trust that signal
    // and skip the fetch. Avoids wasted work and prevents "fetch failed"
    // rows from showing as unknown when we already know they're affiliates.
    if (lead.monday_board === 'affiliates') {
      await svc
        .from('google_lead_gen_table')
        .update({
          is_affiliate: true,
          affiliate_confidence: 'MONDAY_AFFILIATE_BOARD',
          affiliate_indicators: ['Already on Monday Affiliates board'],
          affiliate_checked_at: now,
        })
        .eq('id', lead.id)
      skippedCount++
      continue
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
  if (qErr) return { status: 'error', error: safeError(qErr, 'Failed to enqueue enrichment work.') }

  await logActivity({
    action: 'enrichment.affiliate',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { enqueued: enqueueable.length, skipped: skippedCount },
  })

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
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code, result_type')
    .eq('scrape_job_id', jobId)
    .is('is_rooster_overridden_at', null)
  if (leadsErr) return { status: 'error', error: safeError(leadsErr, 'Failed to load leads for this job.') }

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
  if (qErr) return { status: 'error', error: safeError(qErr, 'Failed to enqueue enrichment work.') }

  await logActivity({
    action: 'enrichment.rooster',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { enqueued: enqueueable.length, skipped: skippedCount },
  })

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
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code')
    .eq('scrape_job_id', jobId)
    .is('is_contact_overridden_at', null)
  if (leadsErr) return { status: 'error', error: safeError(leadsErr, 'Failed to load leads for this job.') }

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
  if (qErr) return { status: 'error', error: safeError(qErr, 'Failed to enqueue enrichment work.') }

  await logActivity({
    action: 'enrichment.contact',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { enqueued: enqueueable.length, skipped: skippedCount },
  })

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
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, country_code, is_affiliate')
    .eq('scrape_job_id', jobId)
    .eq('is_affiliate', true)
    .is('is_stag_overridden_at', null)
  if (leadsErr) return { status: 'error', error: safeError(leadsErr, 'Failed to load leads for this job.') }

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
  if (qErr) return { status: 'error', error: safeError(qErr, 'Failed to enqueue enrichment work.') }

  await logActivity({
    action: 'enrichment.stag',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { enqueued: enqueueable.length, skipped: skippedCount },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Enqueued ${enqueueable.length} s-tag job${enqueueable.length === 1 ? '' : 's'}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}. VM workers will crawl listing pages, follow tracking redirects in the country profile, and verify each tag against Monday.`,
  }
}

// ============================================================
// Cancel an in-flight enrichment stage for one scrape job.
//
// Pending rows for that (scrape_job, stage) flip to status='cancelled' so
// the worker won't pick them up. Rows already running get
// cancel_requested=true; the worker checks this between heavy iterations
// (e.g. between tracking-link redirects in the s-tag stage) and stops
// early, leaving partial results intact.
// ============================================================
const CANCELLABLE_STAGES = ['affiliate', 'rooster', 'contact', 'stag'] as const
type CancellableStage = (typeof CANCELLABLE_STAGES)[number]

export async function cancelEnrichmentStage(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const stage = String(fd.get('stage') ?? '').trim().toLowerCase()
  if (!CANCELLABLE_STAGES.includes(stage as CancellableStage)) {
    return { status: 'error', error: `Unknown stage "${stage}".` }
  }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('cancel_enrichment_stage', {
    p_job_id: jobId,
    p_stage: stage,
  })
  if (error) return { status: 'error', error: safeError(error, 'Failed to cancel the enrichment stage.') }

  const row = (data ?? {}) as { cancelled_pending?: number; flagged_running?: number }
  const cancelledPending = row.cancelled_pending ?? 0
  const flaggedRunning = row.flagged_running ?? 0

  await logActivity({
    action: 'enrichment.cancel_stage',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { stage, cancelled_pending: cancelledPending, flagged_running: flaggedRunning },
  })

  revalidatePath(`/scrape/${jobId}`)

  if (cancelledPending === 0 && flaggedRunning === 0) {
    return { status: 'ok', message: `Nothing in flight for ${stage} — already finished or never started.` }
  }
  const parts: string[] = []
  if (cancelledPending > 0) parts.push(`${cancelledPending} pending cancelled`)
  if (flaggedRunning > 0) parts.push(`${flaggedRunning} running asked to stop`)
  return {
    status: 'ok',
    message: `${parts.join(' · ')}. Running rows finish their current step and exit; partial results are kept.`,
  }
}

// ============================================================
// Epic 9 — Job lifecycle actions: pause / resume / cancel / delete
//
// Pause / resume = direct status flips on scrape_queue (and on the
// follow-on enrichment_fetch_queue rows if any are still pending).
// Workers naturally skip rows whose status isn't 'pending', so no
// VM-side change is needed.
//
// Cancel + delete are gated by a typed-confirmation: the caller must
// send `confirmation_text` matching the job's exact keyword. The server
// computes the expected value itself so the form can't lie.
// Cancel marks the job (and any pending enrichment) as cancelled but
// keeps the rows for audit. Delete wipes everything via the cascade RPC.
// ============================================================
export type JobActionState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

async function flipScrapeStatus(
  jobId: string,
  from: string[],
  to: string,
): Promise<{ ok: true; row: { id: string; keyword: string } } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('scrape_queue')
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .in('status', from)
    .select('id, keyword')
    .maybeSingle()
  if (error) return { ok: false, error: safeError(error, 'Failed to update job status.') }
  if (!data) return { ok: false, error: `Job is not in a ${from.join('/')} state.` }
  return { ok: true, row: data as { id: string; keyword: string } }
}

export async function resetCaptchaRetries(
  _prev: JobActionState,
  fd: FormData,
): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('reset_captcha_retries', { p_job_id: jobId })
  if (error) return { status: 'error', error: safeError(error, 'Failed to reset captcha retries.') }

  await logActivity({
    action: 'scrape.reset_captcha',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { prior_status: data ?? null },
  })

  revalidatePath('/scrape')
  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      data === 'no-op'
        ? 'Job is not in captcha state — nothing to reset.'
        : 'Captcha counter reset. Workers will retry up to 10 more times.',
  }
}

export async function pauseScrapeJob(_prev: JobActionState, fd: FormData): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const r = await flipScrapeStatus(jobId, ['pending'], 'paused')
  if (!r.ok) return { status: 'error', error: r.error }

  await logActivity({
    action: 'scrape.pause',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { keyword: r.row.keyword },
  })
  revalidatePath('/scrape')
  revalidatePath(`/scrape/${jobId}`)
  return { status: 'ok', message: `Paused "${r.row.keyword}". Workers will skip it.` }
}

export async function resumeScrapeJob(_prev: JobActionState, fd: FormData): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const r = await flipScrapeStatus(jobId, ['paused'], 'pending')
  if (!r.ok) return { status: 'error', error: r.error }

  await logActivity({
    action: 'scrape.resume',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { keyword: r.row.keyword },
  })
  revalidatePath('/scrape')
  revalidatePath(`/scrape/${jobId}`)
  return { status: 'ok', message: `Resumed "${r.row.keyword}". Next free worker will pick it up.` }
}

export async function pauseEnrichmentForJob(
  _prev: JobActionState,
  fd: FormData,
): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data: leadRows } = await svc
    .from('google_lead_gen_table')
    .select('id')
    .eq('scrape_job_id', jobId)
  const leadIds = ((leadRows ?? []) as { id: number }[]).map(r => r.id)
  if (leadIds.length === 0) {
    return { status: 'ok', message: 'No leads on this job — nothing to pause.' }
  }

  const { error, count } = await svc
    .from('enrichment_fetch_queue')
    .update({ status: 'paused', updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('status', 'pending')
    .in('lead_id', leadIds)
  if (error) return { status: 'error', error: safeError(error, 'Failed to pause enrichment for this job.') }

  await logActivity({
    action: 'enrichment.pause',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { affected: count ?? 0 },
  })
  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      (count ?? 0) === 0
        ? 'No pending enrichment rows to pause.'
        : `Paused ${count} pending enrichment row${count === 1 ? '' : 's'}. Running rows will finish.`,
  }
}

export async function forceCompleteEnrichment(
  _prev: JobActionState,
  fd: FormData,
): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('force_complete_enrichment', { p_job_id: jobId })
  if (error) return { status: 'error', error: safeError(error, 'Failed to force-complete enrichment.') }

  await logActivity({
    action: 'enrichment.force_complete',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { result: data ?? null },
  })
  revalidatePath('/scrape')
  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      'Marked enrichment as complete. Any pending queue rows were cancelled — re-enqueue from the leads page if you want to retry specific domains.',
  }
}

export async function resumeEnrichmentForJob(
  _prev: JobActionState,
  fd: FormData,
): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data: leadRows } = await svc
    .from('google_lead_gen_table')
    .select('id')
    .eq('scrape_job_id', jobId)
  const leadIds = ((leadRows ?? []) as { id: number }[]).map(r => r.id)
  if (leadIds.length === 0) {
    return { status: 'ok', message: 'No leads on this job.' }
  }

  const { error, count } = await svc
    .from('enrichment_fetch_queue')
    .update({ status: 'pending', updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('status', 'paused')
    .in('lead_id', leadIds)
  if (error) return { status: 'error', error: safeError(error, 'Failed to resume enrichment for this job.') }

  await logActivity({
    action: 'enrichment.resume',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { affected: count ?? 0 },
  })
  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      (count ?? 0) === 0
        ? 'No paused enrichment rows to resume.'
        : `Resumed ${count} enrichment row${count === 1 ? '' : 's'}.`,
  }
}

/** Queues a fresh scrape for the same keyword/country/pages, but with
 *  result_type_filter set so only PPC (or Organic) rows are inserted.
 *  Useful when one result type fails or comes back malformed and you
 *  don't want to re-pay for a full re-scrape that includes the type
 *  that already worked. */
export async function rerunScrapeFiltered(
  _prev: EnqueueState,
  fd: FormData,
): Promise<EnqueueState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  // result_type_filter accepts:
  //   'PPC'     → only PPC rows land in the table
  //   'Organic' → only Organic rows land
  //   'both' / '' → no filter; full SERP is captured (a normal re-run)
  const filterRawIn = String(fd.get('result_type_filter') ?? '').trim()
  let filterValue: 'PPC' | 'Organic' | null
  if (filterRawIn === 'PPC' || filterRawIn === 'Organic') {
    filterValue = filterRawIn
  } else if (filterRawIn === '' || filterRawIn === 'both') {
    filterValue = null
  } else {
    return { status: 'error', error: 'Invalid filter (expected "PPC", "Organic", or "both").' }
  }

  const svc = createServiceClient()
  // Carry over created_by_* from the source so the clone preserves
  // ownership lineage — otherwise the new row is orphaned and
  // requireJobAccess() would refuse to let the original owner mutate
  // their own re-run (BUGS.md R2-14).
  const { data: job, error: readErr } = await svc
    .from('scrape_queue')
    .select('keyword, country_code, pages, priority, with_enrichment, language, search_engine, view_mode, created_by_email, created_by_username, created_by_display')
    .eq('id', jobId)
    .maybeSingle()
  if (readErr) return { status: 'error', error: safeError(readErr, 'Failed to load the source job.') }
  if (!job) return { status: 'error', error: 'Original job not found.' }
  const j = job as {
    keyword: string
    country_code: string
    pages: number
    priority: number
    with_enrichment: boolean
    language: string | null
    search_engine: 'google' | 'bing' | 'youtube' | null
    view_mode: 'desktop' | 'mobile' | 'both' | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
  }

  const { error: insertError } = await svc.from('scrape_queue').insert({
    keyword: j.keyword,
    country_code: j.country_code,
    pages: j.pages,
    priority: j.priority,
    with_enrichment: j.with_enrichment,
    language: j.language ?? 'en',
    search_engine: j.search_engine ?? 'google',
    view_mode: j.view_mode ?? 'both',
    result_type_filter: filterValue,
    created_by_email: j.created_by_email,
    created_by_username: j.created_by_username,
    created_by_display: j.created_by_display,
  })
  if (insertError) return { status: 'error', error: safeError(insertError, 'Failed to queue the scrape.') }

  await logActivity({
    action: 'scrape.rerun_filtered',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { keyword: j.keyword, filter: filterValue ?? 'both' },
  })

  revalidatePath('/scrape')
  const label = filterValue ?? 'both result types'
  return {
    status: 'ok',
    message: `Queued a ${label} re-run for "${j.keyword}". Workers will pick it up within ~5 s.`,
  }
}

// Re-queue a clone of the source job with view_mode forced to 'mobile'.
// Triggered from the scrape detail page when the original 'both' job's
// mobile pass got silently aborted on a captcha — the desktop results
// are intact, but we never captured the mobile breakdown for the
// keyword. The clone returns the mobile data via the regular Captcha
// solver path (no silent abort in 'mobile' mode).
export type RerunMobileOnlyState =
  | { status: 'ok'; message: string; newJobId: string }
  | { status: 'error'; error: string }
  | null

export async function rerunMobileOnly(
  _prev: RerunMobileOnlyState,
  fd: FormData,
): Promise<RerunMobileOnlyState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data: job, error: readErr } = await svc
    .from('scrape_queue')
    .select('keyword, country_code, pages, priority, with_enrichment, language, search_engine, view_mode, result_type_filter, result_summary, created_by_email, created_by_username, created_by_display')
    .eq('id', jobId)
    .maybeSingle()
  if (readErr) return { status: 'error', error: safeError(readErr, 'Failed to load the source job.') }
  if (!job) return { status: 'error', error: 'Original job not found.' }
  const j = job as {
    keyword: string
    country_code: string
    pages: number
    priority: number
    with_enrichment: boolean
    language: string | null
    search_engine: 'google' | 'bing' | 'youtube' | null
    view_mode: 'desktop' | 'mobile' | 'both' | null
    result_type_filter: 'PPC' | 'Organic' | null
    result_summary: Record<string, unknown> | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
  }

  // Guardrail: only meaningful when the source actually had its mobile
  // pass captcha-aborted. If the operator triggers this from any other
  // state (e.g. clean 'both' job, mobile-only job) the rerun would just
  // duplicate work or hit the same captcha — refuse politely instead of
  // silently queueing.
  const skipped = j.result_summary?.['mobile_pass_skipped']
  if (skipped !== 'captcha') {
    return {
      status: 'error',
      error: 'This job\'s mobile pass was not captcha-aborted — nothing to re-run.',
    }
  }

  const { data: inserted, error: insertError } = await svc
    .from('scrape_queue')
    .insert({
      keyword: j.keyword,
      country_code: j.country_code,
      pages: j.pages,
      priority: j.priority,
      with_enrichment: j.with_enrichment,
      language: j.language ?? 'en',
      search_engine: j.search_engine ?? 'google',
      view_mode: 'mobile',
      result_type_filter: j.result_type_filter,
      created_by_email: j.created_by_email,
      created_by_username: j.created_by_username,
      created_by_display: j.created_by_display,
    })
    .select('id')
    .single()
  if (insertError || !inserted) {
    return { status: 'error', error: safeError(insertError, 'Failed to queue the mobile-only re-run.') }
  }
  const newJobId = (inserted as { id: string }).id

  await logActivity({
    action: 'scrape.rerun_mobile_only',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { keyword: j.keyword, new_job_id: newJobId },
  })

  revalidatePath('/scrape')
  return {
    status: 'ok',
    newJobId,
    message: `Queued a mobile-only re-run for "${j.keyword}".`,
  }
}

async function checkConfirmation(
  jobId: string,
  confirmationText: string,
): Promise<{ ok: true; keyword: string } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('scrape_queue')
    .select('keyword')
    .eq('id', jobId)
    .maybeSingle()
  if (error) return { ok: false, error: safeError(error, 'Failed to look up the job.') }
  if (!data) return { ok: false, error: 'Job not found.' }
  const keyword = (data as { keyword: string }).keyword
  // Trim both sides — keywords are stored trimmed on insert, but a
  // one-sided trim still misclassifies legitimate matches if the DB
  // value ever picks up whitespace from another path.
  if (confirmationText.trim() !== keyword.trim()) {
    return {
      ok: false,
      error: `Confirmation text doesn't match the keyword "${keyword}".`,
    }
  }
  return { ok: true, keyword }
}

export async function cancelScrapeJob(_prev: JobActionState, fd: FormData): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const confirmation = String(fd.get('confirmation_text') ?? '')
  const check = await checkConfirmation(jobId, confirmation)
  if (!check.ok) return { status: 'error', error: check.error }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('cancel_scrape_job', { p_job_id: jobId })
  if (error) return { status: 'error', error: safeError(error, 'Failed to cancel the scrape job.') }

  await logActivity({
    action: 'scrape.cancel',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { keyword: check.keyword, prior_status: data ?? null },
  })
  revalidatePath('/scrape')
  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      data === 'no-op'
        ? 'Job already in a terminal state — nothing to cancel.'
        : `Cancelled "${check.keyword}". Pending enrichment for this job is also cancelled.`,
  }
}

export async function deleteScrapeJob(_prev: JobActionState, fd: FormData): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const confirmation = String(fd.get('confirmation_text') ?? '')
  const check = await checkConfirmation(jobId, confirmation)
  if (!check.ok) return { status: 'error', error: check.error }

  const svc = createServiceClient()

  // Pull screenshot paths first; storage cleanup is best-effort.
  const { data: shotRows } = await svc
    .from('google_lead_gen_table')
    .select('screenshot_content_link')
    .eq('scrape_job_id', jobId)
    .not('screenshot_content_link', 'is', null)
  const screenshotPaths = ((shotRows ?? []) as { screenshot_content_link: string }[])
    .map(r => r.screenshot_content_link)
    .filter(p => typeof p === 'string' && p.length > 0)
  if (screenshotPaths.length > 0) {
    try {
      await svc.storage.from('lead-screenshots').remove(screenshotPaths)
    } catch {
      /* best-effort */
    }
  }

  // Also clean up s-tag screenshots if any.
  const { data: stagShots } = await svc
    .from('s_tags_table')
    .select('screenshot_path')
    .in(
      'lead_id',
      ((
        await svc
          .from('google_lead_gen_table')
          .select('id')
          .eq('scrape_job_id', jobId)
      ).data ?? []).map((r: { id: number }) => r.id),
    )
    .not('screenshot_path', 'is', null)
  const stagPaths = ((stagShots ?? []) as { screenshot_path: string }[])
    .map(r => r.screenshot_path)
    .filter(p => typeof p === 'string' && p.length > 0)
  if (stagPaths.length > 0) {
    try {
      await svc.storage.from('lead-screenshots').remove(stagPaths)
    } catch {
      /* best-effort */
    }
  }

  const { data, error } = await svc.rpc('delete_scrape_job_cascade', { p_job_id: jobId })
  if (error) return { status: 'error', error: safeError(error, 'Failed to delete the scrape job.') }
  const leadCount = typeof data === 'number' ? data : 0

  await logActivity({
    action: 'scrape.delete',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: {
      keyword: check.keyword,
      leads_deleted: leadCount,
      screenshots_deleted: screenshotPaths.length + stagPaths.length,
    },
  })
  revalidatePath('/scrape')
  return {
    status: 'ok',
    message: `Deleted "${check.keyword}" — ${leadCount} lead${leadCount === 1 ? '' : 's'} and all enrichment data wiped.`,
  }
}

// ============================================================
// Epic 7.6 — S-Tag Duplicate Check (Monday mirror)
// ============================================================
export async function runStagDuplicateCheck(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('mark_s_tag_duplicates_for_job', {
    p_job_id: jobId,
  })
  if (error) return { status: 'error', error: safeError(error, 'Failed to check s-tag duplicates.') }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { checked: number; matched: number }
    | null
  const checked = row?.checked ?? 0
  const matched = row?.matched ?? 0

  await logActivity({
    action: 'enrichment.stag_dup_check',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { checked, matched },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message:
      checked === 0
        ? 'No s-tags to check — run S-tag extraction first.'
        : `Checked ${checked} s-tag${checked === 1 ? '' : 's'} — ${matched} already on Monday.`,
  }
}

// ============================================================
// Bulk-select actions on /scrape:
//   - bulkRerunScrapeJobs   — re-queue selected jobs (same keyword/
//                              country/pages/etc), no confirmation
//                              required since it doesn't destroy data.
//   - bulkDeleteScrapeJobs  — wipe selected jobs + every lead/screenshot/
//                              s-tag belonging to them. Two safety
//                              gates: typed confirmation phrase AND
//                              admin password re-verification.
//
// Both actions are admin-gated. The whole point is to clean up
// quickly-failed batches without playing whack-a-mole on the kebab.
// ============================================================

export type BulkScrapeActionState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

function parseJobIds(fd: FormData): string[] {
  const raw = String(fd.get('job_ids') ?? '').trim()
  if (!raw) return []
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0),
    ),
  )
}

async function requireBulkAdmin(): Promise<
  | { ok: true; user_id: string; user_email: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (error) return { ok: false, error: safeError(error, 'Failed to verify admin access.') }
  if (!data) return { ok: false, error: 'Admin access required for bulk actions.' }
  return { ok: true, user_id: user.id, user_email: user.email ?? null }
}

export async function bulkRerunScrapeJobs(
  _prev: BulkScrapeActionState,
  fd: FormData,
): Promise<BulkScrapeActionState> {
  const auth = await requireBulkAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const jobIds = parseJobIds(fd)
  if (jobIds.length === 0) return { status: 'error', error: 'No jobs selected.' }
  if (jobIds.length > 200) return { status: 'error', error: 'Too many jobs selected (max 200).' }

  const svc = createServiceClient()
  // Same created_by_* lineage fix as rerunScrapeFiltered (BUGS.md
  // R2-15). Clones inherit the source row's owner so requireJobAccess
  // still permits the original owner to control the re-run, and the
  // audit log shows continuous attribution.
  const { data: jobs, error: readErr } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, pages, priority, with_enrichment, language, search_engine, view_mode, result_type_filter, created_by_email, created_by_username, created_by_display')
    .in('id', jobIds)
  if (readErr) return { status: 'error', error: safeError(readErr, 'Failed to load the source job.') }

  type Row = {
    id: string
    keyword: string
    country_code: string
    pages: number
    priority: number
    with_enrichment: boolean
    language: string | null
    search_engine: 'google' | 'bing' | 'youtube' | null
    view_mode: 'desktop' | 'mobile' | 'both' | null
    result_type_filter: 'PPC' | 'Organic' | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
  }
  const rows = (jobs ?? []) as Row[]
  if (rows.length === 0) return { status: 'error', error: 'No matching jobs found.' }

  // Insert one fresh queue row per selected source job. Same shape as
  // rerunScrapeFiltered, just batched. Workers pick them up via the
  // normal claim flow within ~5s.
  const inserts = rows.map(r => ({
    keyword: r.keyword,
    country_code: r.country_code,
    pages: r.pages,
    priority: r.priority,
    with_enrichment: r.with_enrichment,
    language: r.language ?? 'en',
    search_engine: r.search_engine ?? 'google',
    view_mode: r.view_mode ?? 'both',
    result_type_filter: r.result_type_filter,
    created_by_email: r.created_by_email,
    created_by_username: r.created_by_username,
    created_by_display: r.created_by_display,
  }))
  const { error: insertErr } = await svc.from('scrape_queue').insert(inserts)
  if (insertErr) return { status: 'error', error: safeError(insertErr, 'Failed to queue the bulk re-run.') }

  await logActivity({
    action: 'scrape.bulk_rerun',
    entity_type: 'scrape_jobs_bulk',
    details: { requested: jobIds.length, queued: rows.length },
  })

  revalidatePath('/scrape')
  return {
    status: 'ok',
    message: `Re-queued ${rows.length} scrape${rows.length === 1 ? '' : 's'}. Workers will pick them up within ~5 s.`,
  }
}

export async function bulkDeleteScrapeJobs(
  _prev: BulkScrapeActionState,
  fd: FormData,
): Promise<BulkScrapeActionState> {
  const auth = await requireBulkAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const jobIds = parseJobIds(fd)
  if (jobIds.length === 0) return { status: 'error', error: 'No jobs selected.' }
  if (jobIds.length > 200) return { status: 'error', error: 'Too many jobs selected (max 200).' }

  // Safety gate 1: typed confirmation. Must read "delete <N>".
  const confirmation = String(fd.get('confirmation_text') ?? '').trim()
  const expected = `delete ${jobIds.length}`
  if (confirmation !== expected) {
    return {
      status: 'error',
      error: `Confirmation must be "${expected}" (got "${confirmation}").`,
    }
  }

  // Safety gate 2: re-verify the caller's password. Catches a
  // walked-away laptop scenario before the cascade fires.
  const password = String(fd.get('admin_password') ?? '')
  if (!password) return { status: 'error', error: 'Admin password is required.' }
  if (!auth.user_email) {
    return { status: 'error', error: 'Cannot verify password — no email on file.' }
  }
  // Verify via a stateless anon client so the admin's session cookies
  // aren't rotated by this check (the cookie-bound client would have
  // overwritten the JWT mid-action).
  const reauthOk = await verifyUserPassword(auth.user_email, password)
  if (!reauthOk) {
    return { status: 'error', error: 'Password is incorrect.' }
  }

  const svc = createServiceClient()

  // Pull every screenshot path (lead-level + s-tag-level) for the
  // selected jobs so storage cleanup happens before the cascade
  // wipes the rows that point to them.
  const { data: leadRows } = await svc
    .from('google_lead_gen_table')
    .select('id, screenshot_content_link')
    .in('scrape_job_id', jobIds)
  type LeadRow = { id: number; screenshot_content_link: string | null }
  const leads = (leadRows ?? []) as LeadRow[]
  const leadIds = leads.map(l => l.id)
  const leadPaths = leads
    .map(l => l.screenshot_content_link)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)

  let stagPaths: string[] = []
  if (leadIds.length > 0) {
    const { data: stagShots } = await svc
      .from('s_tags_table')
      .select('screenshot_path')
      .in('lead_id', leadIds)
      .not('screenshot_path', 'is', null)
    stagPaths = ((stagShots ?? []) as { screenshot_path: string }[])
      .map(r => r.screenshot_path)
      .filter(p => typeof p === 'string' && p.length > 0)
  }
  const allPaths = [...leadPaths, ...stagPaths]
  if (allPaths.length > 0) {
    try {
      await svc.storage.from('lead-screenshots').remove(allPaths)
    } catch {
      /* best-effort */
    }
  }

  // Cascade-delete each job. The existing delete_scrape_job_cascade
  // RPC handles enrichment_fetch_queue + google_lead_gen_table +
  // s_tags_table + contact_table cleanup per job.
  let deleted = 0
  let leadsDeleted = 0
  const errors: string[] = []
  for (const id of jobIds) {
    const { data, error } = await svc.rpc('delete_scrape_job_cascade', { p_job_id: id })
    if (error) {
      errors.push(`${id.slice(0, 8)}: ${error.message}`)
      continue
    }
    deleted += 1
    if (typeof data === 'number') leadsDeleted += data
  }

  await logActivity({
    action: 'scrape.bulk_delete',
    entity_type: 'scrape_jobs_bulk',
    details: {
      requested: jobIds.length,
      deleted,
      leads_deleted: leadsDeleted,
      screenshots_deleted: allPaths.length,
      errors: errors.length,
    },
  })

  revalidatePath('/scrape')
  if (errors.length > 0) {
    return {
      status: 'error',
      error: `Deleted ${deleted}/${jobIds.length}. Errors: ${errors.slice(0, 3).join(' · ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`,
    }
  }
  return {
    status: 'ok',
    message: `Deleted ${deleted} scrape${deleted === 1 ? '' : 's'} and ${leadsDeleted} lead${leadsDeleted === 1 ? '' : 's'} with all enrichment data wiped.`,
  }
}
