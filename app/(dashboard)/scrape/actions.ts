'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { shouldSkipDomain } from '@/lib/affiliate-detection/scorer'
import { logActivity } from '@/lib/activity-log'

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
  const enginesToRun: Array<'google' | 'bing'> =
    engineRaw === 'both'
      ? ['google', 'bing']
      : engineRaw === 'bing'
        ? ['bing']
        : ['google']
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
  if (profileError) return { status: 'error', error: profileError.message }
  if (!profile) return { status: 'error', error: `Unknown country ${country_code}.` }
  if (!profile.is_active) return { status: 'error', error: `Country ${country_code} is disabled.` }
  if (!profile.gologin_profile_id) {
    return { status: 'error', error: `Country ${country_code} has no GoLogin profile configured.` }
  }
  // Reject a language that isn't valid for this country (UI filters but
  // a hand-crafted POST could still slip through).
  const allowedLangs = (profile as { languages: string[] | null }).languages ?? ['en']
  const finalLang = allowedLangs.includes(language) || language === 'en' ? language : 'en'

  // Cross-product: one row per (keyword × engine).
  const rows = keywords.flatMap(keyword =>
    enginesToRun.map(engine => ({
      keyword,
      country_code,
      pages,
      priority,
      with_enrichment: withEnrichment,
      scheduled_at: scheduledAtIso,
      language: finalLang,
      search_engine: engine,
    })),
  )
  const { error: insertError } = await svc.from('scrape_queue').insert(rows)
  if (insertError) return { status: 'error', error: insertError.message }

  const flag = withEnrichment ? ' with full enrichment pipeline' : ''
  const when = scheduledAtIso
    ? ` to run at ${new Date(scheduledAtIso).toLocaleString()}`
    : ''
  const engineDescription =
    enginesToRun.length === 2
      ? ' on Google + Bing'
      : enginesToRun[0] === 'bing'
        ? ' on Bing'
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
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: `Job is not in a ${from.join('/')} state.` }
  return { ok: true, row: data as { id: string; keyword: string } }
}

export async function resetCaptchaRetries(
  _prev: JobActionState,
  fd: FormData,
): Promise<JobActionState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('reset_captcha_retries', { p_job_id: jobId })
  if (error) return { status: 'error', error: error.message }

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
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

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
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

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
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

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
  if (error) return { status: 'error', error: error.message }

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
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('force_complete_enrichment', { p_job_id: jobId })
  if (error) return { status: 'error', error: error.message }

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
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

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
  if (error) return { status: 'error', error: error.message }

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
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

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
  const { data: job, error: readErr } = await svc
    .from('scrape_queue')
    .select('keyword, country_code, pages, priority, with_enrichment, language, search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (readErr) return { status: 'error', error: readErr.message }
  if (!job) return { status: 'error', error: 'Original job not found.' }
  const j = job as {
    keyword: string
    country_code: string
    pages: number
    priority: number
    with_enrichment: boolean
    language: string | null
    search_engine: 'google' | 'bing' | null
  }

  const { error: insertError } = await svc.from('scrape_queue').insert({
    keyword: j.keyword,
    country_code: j.country_code,
    pages: j.pages,
    priority: j.priority,
    with_enrichment: j.with_enrichment,
    language: j.language ?? 'en',
    search_engine: j.search_engine ?? 'google',
    result_type_filter: filterValue,
  })
  if (insertError) return { status: 'error', error: insertError.message }

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
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Job not found.' }
  const keyword = (data as { keyword: string }).keyword
  if (confirmationText.trim() !== keyword) {
    return {
      ok: false,
      error: `Confirmation text doesn't match the keyword "${keyword}".`,
    }
  }
  return { ok: true, keyword }
}

export async function cancelScrapeJob(_prev: JobActionState, fd: FormData): Promise<JobActionState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const confirmation = String(fd.get('confirmation_text') ?? '')
  const check = await checkConfirmation(jobId, confirmation)
  if (!check.ok) return { status: 'error', error: check.error }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('cancel_scrape_job', { p_job_id: jobId })
  if (error) return { status: 'error', error: error.message }

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
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

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
  if (error) return { status: 'error', error: error.message }
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
