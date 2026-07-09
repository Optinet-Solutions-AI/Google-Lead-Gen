'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { shouldSkipDomain } from '@/lib/affiliate-detection/scorer'
import {
  scoreKickStreamer,
  isAffiliateCasinoLink,
  type KickScoreLink,
} from '@/lib/affiliate-detection/kick-scorer'
import { scoreYoutubeChannel, type YoutubeScoreLink } from '@/lib/affiliate-detection/youtube-scorer'
import { scoreXCreator, type XScoreLink } from '@/lib/affiliate-detection/x-scorer'
import { scoreFbAdvertiser, AGGREGATOR_HOSTS, type FbScoreLink } from '@/lib/affiliate-detection/fb-scorer'
import { scoreTiktokCreator, type TiktokScoreLink } from '@/lib/affiliate-detection/tiktok-scorer'
import { scoreSnapchatCreator, type SnapchatScoreLink } from '@/lib/affiliate-detection/snapchat-scorer'
import { scoreTelegramChannel, type TelegramScoreLink } from '@/lib/affiliate-detection/telegram-scorer'
import { scoreTwitchStreamer, type TwitchScoreLink } from '@/lib/affiliate-detection/twitch-scorer'
import { extractContacts } from '@/lib/affiliate-detection/kick-contacts'
import { extractContacts as extractContactsFromHtml } from '@/lib/contact-extraction/extract'
import { fetchPagesHtml } from '@/lib/contact-extraction/fetch-html'
import { needsResolution, resolveShorteners } from '@/lib/affiliate-detection/resolve-links'
import {
  collectCandidates,
  resolveCandidate,
  twoHopStags,
  type ResolvedLink,
} from '@/lib/affiliate-detection/youtube-links'
import { parseStagFromUrl, guessBrandFromUrl } from '@/lib/stag-extraction/extract'
import { decodeAdUrl } from '@/lib/decode-ad-url'
import { logActivity } from '@/lib/activity-log'
import { checkQuota } from '@/lib/scrape-quota'
import { pushJobToMonday as pushJobToMondayLib } from '@/lib/monday/push-job'
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
  const enginesToRun: Array<'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | 'x' | 'facebook' | 'tiktok' | 'snapchat' | 'telegram'> =
    engineRaw === 'both'
      ? ['google', 'bing']
      : engineRaw === 'bing'
        ? ['bing']
        : engineRaw === 'youtube'
          ? ['youtube']
          : engineRaw === 'twitch'
            ? ['twitch']
            : engineRaw === 'kick'
              ? ['kick']
              : engineRaw === 'x'
                ? ['x']
                : engineRaw === 'facebook'
                  ? ['facebook']
                  : engineRaw === 'tiktok'
                    ? ['tiktok']
                    : engineRaw === 'snapchat'
                      ? ['snapchat']
                      : engineRaw === 'telegram'
                        ? ['telegram']
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
  const createdByEmail = (user.email ?? null)?.toLowerCase() ?? null
  const { data: userProfileRow } = await svc
    .from('user_profiles')
    .select('username, display_name, is_shadow')
    .eq('id', user.id)
    .maybeSingle()
  const userProfile = userProfileRow as
    | { username: string | null; display_name: string | null; is_shadow: boolean | null }
    | null
  const fallbackUser = createdByEmail ? createdByEmail.split('@')[0] ?? null : null
  const createdByUsername = userProfile?.username ?? fallbackUser
  const createdByDisplay = userProfile?.display_name ?? createdByUsername
  const createdByIsShadow = userProfile?.is_shadow === true

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
      created_by_is_shadow: createdByIsShadow,
    })),
  )

  // Daily-quota gate. Admins are exempt; everyone else gets up to
  // system_settings.daily_scrape_cap_per_user rows per UTC day. The
  // friendly error message already includes used/cap/remaining so
  // the EnqueueForm can render it as-is.
  const quota = await checkQuota(rows.length)
  if (!quota.ok) return { status: 'error', error: quota.error }

  const { error: insertError } = await svc.from('scrape_queue').insert(rows)
  if (insertError) return { status: 'error', error: safeError(insertError, 'Failed to queue the scrape.') }

  const flag = withEnrichment ? ' with full enrichment pipeline' : ''
  const when = scheduledAtIso
    ? ` to run at ${new Date(scheduledAtIso).toLocaleString()}`
    : ''
  // Label every selectable engine (google stays unlabelled as the implicit
  // default). Without this, queueing a Kick/X/FB/TikTok/Snapchat/Telegram job
  // produced a toast with no engine indicator.
  const ENGINE_LABELS: Record<string, string> = {
    bing: ' on Bing',
    youtube: ' on YouTube',
    kick: ' on Kick',
    x: ' on X',
    facebook: ' on Facebook',
    tiktok: ' on TikTok',
    snapchat: ' on Snapchat',
    telegram: ' on Telegram',
    twitch: ' on Twitch',
  }
  const engineDescription =
    enginesToRun.length === 2
      ? ' on Google + Bing'
      : (ENGINE_LABELS[enginesToRun[0] ?? ''] ?? '')

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
      // Decode Google aclk / Bing aclick click-tracker URLs so the worker
      // fetches the real advertiser landing page instead of the redirector
      // (which often expires and bounces to a stale Bing/Google results
      // page — the "screenshot of a Google results page" report). Mirrors
      // the auto-enrichment path in app/api/scheduler/tick (commit 10ab2f4),
      // which this manual ▶ re-run path was missing.
      url: decodeAdUrl(url),
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
// Kick Phase 2 — operator-triggered profile enrichment
//
// Unlike the affiliate/contact/s-tag stages (which enqueue into
// enrichment_fetch_queue and run on the enrichment workers), Phase 2 is
// a real browser scrape of kick.com/{slug} behind Cloudflare — so it
// enqueues a *new scrape_queue row* that the GoLogin scrape workers
// claim. The row is tagged parent_scrape_job_id=<this Kick job>; the
// worker selects that parent's top-N un-enriched streamers and backfills
// socials, follower_count, and promo_card / pinned_chat links straight
// into kick_streamers / kick_links. N is a VM-side cap (KICK_PHASE2_TOP_N).
// ============================================================
export async function runKickProfileEnrichment(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd) // the parent Phase-1 Kick job
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  // Load the parent job + verify it's a Kick job, and carry over the
  // created_by_* lineage so the enrichment row isn't orphaned (otherwise
  // requireJobAccess would later refuse the original owner — same reason
  // as the re-run clone, BUGS.md R2-14).
  const { data: job, error: readErr } = await svc
    .from('scrape_queue')
    .select(
      'keyword, country_code, language, search_engine, created_by_email, created_by_username, created_by_display, created_by_is_shadow',
    )
    .eq('id', jobId)
    .maybeSingle()
  if (readErr) return { status: 'error', error: safeError(readErr, 'Failed to load the source job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  const j = job as {
    keyword: string
    country_code: string
    language: string | null
    search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
  }
  if ((j.search_engine ?? '') !== 'kick') {
    return { status: 'error', error: 'Profile enrichment only applies to Kick scrape jobs.' }
  }

  // Need streamers that haven't had their about page scraped yet.
  const { count: pending, error: cntErr } = await svc
    .from('kick_streamers')
    .select('id', { count: 'exact', head: true })
    .eq('scrape_queue_id', jobId)
    .is('about_scraped_at', null)
    // Exclude rows already marked permanently failed — a re-run shouldn't
    // re-enqueue work for profiles that can never be enriched (mirrors the
    // VM-side work-list filter).
    .or('about_fetch_failed.is.null,about_fetch_failed.eq.false')
  if (cntErr) return { status: 'error', error: safeError(cntErr, 'Failed to count discovered streamers.') }
  if (!pending || pending === 0) {
    revalidatePath(`/scrape/${jobId}`)
    return {
      status: 'ok',
      message: 'No streamers left to enrich — every discovered profile has been scraped or marked unreachable.',
    }
  }

  // Don't stack Phase 2 jobs: bail if one is already queued/running for
  // this parent so a double-click doesn't burn two GoLogin sessions.
  const { count: inflight, error: ifErr } = await svc
    .from('scrape_queue')
    .select('id', { count: 'exact', head: true })
    .eq('parent_scrape_job_id', jobId)
    .in('status', ['pending', 'running'])
  if (ifErr) return { status: 'error', error: safeError(ifErr, 'Failed to check for an in-flight enrichment job.') }
  if (inflight && inflight > 0) {
    return { status: 'error', error: 'A profile-enrichment run is already queued or running for this job.' }
  }

  const { error: insertError } = await svc.from('scrape_queue').insert({
    keyword: j.keyword,
    country_code: j.country_code,
    search_engine: 'kick',
    parent_scrape_job_id: jobId,
    language: j.language,
    priority: 0,
    with_enrichment: false,
    created_by_email: j.created_by_email,
    created_by_username: j.created_by_username,
    created_by_display: j.created_by_display,
    created_by_is_shadow: j.created_by_is_shadow ?? false,
  })
  if (insertError) return { status: 'error', error: safeError(insertError, 'Failed to queue profile enrichment.') }

  await logActivity({
    action: 'enrichment.kick_profile',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { pending_streamers: pending },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Queued profile enrichment. A VM worker will open the top streamers (by live viewers) through GoLogin and backfill socials, follower count, and promo / pinned-chat links. ${pending} streamer${pending === 1 ? '' : 's'} still pending.`,
  }
}

// ============================================================
// Kick Phase 3 — affiliate scoring + shortener resolution
//
// Pure data work (+ light HTTP for shorteners), so it runs INLINE in this
// action rather than as a VM/queue job. Resolves shortener-like kick_links
// to their real destination, then scores each kick_streamer on the Phase
// 1/2 signals (casino promo cards, affiliate-ref links, gambling tags,
// casino keywords) → is_likely_affiliate + niche_score. No migration / no
// VM — the columns were reserved in Phase 1.
// ============================================================
export async function runKickStreamerAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'kick') {
    return { status: 'error', error: 'Scoring only applies to Kick scrape jobs.' }
  }

  // Streamers for this job + all their links.
  const { data: streamers, error: sErr } = await svc
    .from('kick_streamers')
    .select(
      'id, slug, channel_description, stream_title, custom_tags, category_name, ' +
        'instagram_handle, twitter_handle, facebook_handle, youtube_handle, tiktok_handle',
    )
    .eq('scrape_queue_id', jobId)
  if (sErr) return { status: 'error', error: safeError(sErr, 'Failed to load streamers.') }
  if (!streamers || streamers.length === 0) {
    return { status: 'ok', message: 'No streamers to score yet — run the Kick scrape first.' }
  }
  const streamerIds = (streamers as unknown as Array<{ id: string }>).map(s => s.id)

  const { data: links, error: lErr } = await svc
    .from('kick_links')
    .select(
      'id, kick_streamer_id, url, resolved_url, source, promo_brand, promo_bonus_terms, ' +
        's_tag, brand, is_known_on_monday',
    )
    .in('kick_streamer_id', streamerIds)
  if (lErr) return { status: 'error', error: safeError(lErr, 'Failed to load streamer links.') }
  const allLinks = (links ?? []) as unknown as Array<
    KickScoreLink & {
      id: string
      kick_streamer_id: string
      s_tag: string | null
      brand: string | null
      is_known_on_monday: boolean | null
    }
  >

  // Casino-operator domain set (host suffixes) for promo-link classification.
  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  // 1. Resolve shortener-like links that aren't resolved yet.
  const toResolve = allLinks
    .filter(l => !l.resolved_url && needsResolution(l.resolved_url ?? l.url))
    .map(l => l.url)
  let linksResolved = 0
  if (toResolve.length > 0) {
    const resolvedMap = await resolveShorteners(toResolve)
    const nowIso = new Date().toISOString()
    for (const l of allLinks) {
      const resolved = resolvedMap.get(l.url)
      if (!resolved) continue
      l.resolved_url = resolved // reflect locally so scoring sees it
      const { error: upErr } = await svc
        .from('kick_links')
        .update({ resolved_url: resolved, resolved_at: nowIso })
        .eq('id', l.id)
      if (!upErr) linksResolved++
    }
  }

  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // 2. Parse the S-tag / operator brand for each casino link + check it
  // against Monday (search_s_tag_on_monday) — same pattern as the twitch
  // scorer this one mirrors. Non-casino links (own site, plain socials) are
  // left null. Writes the per-link Monday verdict back to kick_links so the
  // "On Monday" column can show which URLs matched.
  let affiliateLinks = 0
  for (const l of allLinks) {
    const dest = l.resolved_url ?? l.url
    const parsed = parseStagFromUrl(dest)
    const isCasino = !!parsed || isAffiliateCasinoLink(dest, denylist)
    if (!isCasino) continue
    affiliateLinks++
    const brand = guessBrandFromUrl(dest)
    const checkKey = parsed?.tag || brand || ''
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) hit = await checkMonday(checkKey)
    const update = {
      s_tag: parsed?.tag ?? null,
      s_tag_param: parsed?.param ?? null,
      brand,
      is_known_on_monday: checkKey ? !!hit : null,
      monday_match_kind: hit?.kind ?? null,
      monday_match_item_id: hit?.item_id ?? null,
    }
    const { error: upErr } = await svc.from('kick_links').update(update).eq('id', l.id)
    if (!upErr) {
      l.s_tag = update.s_tag
      l.brand = update.brand
      l.is_known_on_monday = update.is_known_on_monday
    }
  }

  // 3. Score each streamer + derive the new-vs-known verdict.
  type KickLinkFull = (typeof allLinks)[number]
  const linksByStreamer = new Map<string, KickLinkFull[]>()
  for (const l of allLinks) {
    const arr = linksByStreamer.get(l.kick_streamer_id) ?? []
    arr.push(l)
    linksByStreamer.set(l.kick_streamer_id, arr)
  }

  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  let withContacts = 0
  for (const s of streamers as unknown as Array<{
    id: string
    slug: string
    channel_description: string | null
    stream_title: string | null
    custom_tags: string[] | null
    category_name: string | null
    instagram_handle: string | null
    twitter_handle: string | null
    facebook_handle: string | null
    youtube_handle: string | null
    tiktok_handle: string | null
  }>) {
    const streamerLinks = linksByStreamer.get(s.id) ?? []
    const result = scoreKickStreamer(s, streamerLinks, denylist)

    // Mine outreach contacts from the bio/title + the links Phase 2 captured
    // (url + resolved_url so a shortener that expanded to a t.me/discord
    // invite still counts). email > Telegram > Discord per the playbook.
    const linkUrls = streamerLinks.flatMap(l =>
      [l.resolved_url, l.url].filter((u): u is string => !!u),
    )
    const contacts = extractContacts(
      [s.channel_description ?? '', s.stream_title ?? ''],
      linkUrls,
    )

    // New-vs-known: a likely affiliate is "new" if any of its casino links
    // resolved to an S-tag/brand NOT on Monday, or its channel slug (the
    // kick.com/{slug} identity, Kick's analogue of the Twitch @login) isn't
    // on Monday. Mirror the twitch verdict exactly.
    const hasNewTag = streamerLinks.some(l => l.is_known_on_monday === false)
    let handleIsNew = false
    let handleChecked = false
    if (result.isLikelyAffiliate) {
      const handle = (s.slug ?? '').replace(/^@/, '').trim()
      if (handle.length >= 2) {
        const known = await checkMonday(handle)
        handleIsNew = !known
        handleChecked = true
      }
    }
    const isNewCandidate = result.isLikelyAffiliate && (hasNewTag || handleIsNew)

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      niche_score: result.nicheScore,
      is_new_lead_candidate: isNewCandidate,
      is_known_on_monday: result.isLikelyAffiliate && handleChecked ? !handleIsNew : null,
      contact_email: contacts.email,
      telegram_url: contacts.telegram_url,
      discord_url: contacts.discord_url,
    }
    // Fill only socials Phase 2 missed — never clobber a handle the browser
    // scrape already captured (its channel-link cards are higher-fidelity).
    if (!s.instagram_handle && contacts.socials.instagram) update.instagram_handle = contacts.socials.instagram
    if (!s.twitter_handle && contacts.socials.twitter) update.twitter_handle = contacts.socials.twitter
    if (!s.facebook_handle && contacts.socials.facebook) update.facebook_handle = contacts.socials.facebook
    if (!s.youtube_handle && contacts.socials.youtube) update.youtube_handle = contacts.socials.youtube
    if (!s.tiktok_handle && contacts.socials.tiktok) update.tiktok_handle = contacts.socials.tiktok

    const { error: upErr } = await svc.from('kick_streamers').update(update).eq('id', s.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (isNewCandidate) newCandidates++
    if (contacts.email || contacts.telegram_url || contacts.discord_url) withContacts++
  }

  await logActivity({
    action: 'enrichment.kick_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, linksResolved, withContacts },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} streamer${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}, ${withContacts} with contact${withContacts === 1 ? '' : 's'}${linksResolved > 0 ? `, ${linksResolved} link${linksResolved === 1 ? '' : 's'} resolved` : ''}.`,
  }
}

// ============================================================
// YouTube Phase 2 — contact enrichment (operator-triggered ▶)
//
// Queues a browser scrape_queue job (search_engine='youtube' +
// parent_scrape_job_id) that a GoLogin worker claims and runs
// youtube_profile_scrape.py over: it opens each discovered channel's About
// tab and backfills website/socials + the reCAPTCHA-gated email. Mirrors
// runKickProfileEnrichment exactly — same in-flight guard, same lineage
// carry-over so requireJobAccess doesn't later refuse the owner.
// ============================================================
export async function runYoutubeContactEnrichment(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd) // the parent Phase-1 YouTube job
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: readErr } = await svc
    .from('scrape_queue')
    .select(
      'keyword, country_code, language, search_engine, created_by_email, created_by_username, created_by_display, created_by_is_shadow',
    )
    .eq('id', jobId)
    .maybeSingle()
  if (readErr) return { status: 'error', error: safeError(readErr, 'Failed to load the source job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  const j = job as {
    keyword: string
    country_code: string
    language: string | null
    search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
  }
  if ((j.search_engine ?? '') !== 'youtube') {
    return { status: 'error', error: 'Contact enrichment only applies to YouTube scrape jobs.' }
  }

  // Channels that haven't had their About tab scraped yet.
  const { count: pending, error: cntErr } = await svc
    .from('youtube_channels')
    .select('id', { count: 'exact', head: true })
    .eq('scrape_queue_id', jobId)
    .is('about_tab_scraped_at', null)
  if (cntErr) return { status: 'error', error: safeError(cntErr, 'Failed to count discovered channels.') }
  if (!pending || pending === 0) {
    revalidatePath(`/scrape/${jobId}`)
    return {
      status: 'ok',
      message: 'No channels left to enrich — every discovered channel already has its About tab scraped.',
    }
  }

  // Don't stack Phase 2 jobs: bail if one is already queued/running for this
  // parent so a double-click doesn't burn two GoLogin sessions.
  const { count: inflight, error: ifErr } = await svc
    .from('scrape_queue')
    .select('id', { count: 'exact', head: true })
    .eq('parent_scrape_job_id', jobId)
    .in('status', ['pending', 'running'])
  if (ifErr) return { status: 'error', error: safeError(ifErr, 'Failed to check for an in-flight enrichment job.') }
  if (inflight && inflight > 0) {
    return { status: 'error', error: 'A contact-enrichment run is already queued or running for this job.' }
  }

  // The About-tab email is gated behind a "View email address" button that
  // only appears for a Google-LOGGED-IN session. A channel's About content is
  // geo-independent, so we run enrichment under a logged-in profile's country
  // regardless of the parent job's country — claim_scrape_job then locks that
  // country, keeping GoLogin-profile concurrency correct (no double-use of the
  // same profile). Channel selection is by parent_scrape_job_id, so it's
  // unaffected by the country swap.
  const { data: liProfiles, error: liErr } = await svc
    .from('gologin_profiles')
    .select('country_code')
    .eq('is_google_logged_in', true)
    .eq('is_active', true)
    .not('gologin_profile_id', 'is', null)
    .order('country_code', { ascending: true })
    .limit(1)
  if (liErr) return { status: 'error', error: safeError(liErr, 'Failed to look up a logged-in profile.') }
  const loggedInCountry = (liProfiles?.[0] as { country_code: string } | undefined)?.country_code
  if (!loggedInCountry) {
    return {
      status: 'error',
      error:
        'No Google-logged-in GoLogin profile is available — contact enrichment needs one to read the About-tab email. Log into Google on an active profile first.',
    }
  }

  const { error: insertError } = await svc.from('scrape_queue').insert({
    keyword: j.keyword,
    country_code: loggedInCountry,
    search_engine: 'youtube',
    parent_scrape_job_id: jobId,
    language: j.language,
    priority: 0,
    with_enrichment: false,
    created_by_email: j.created_by_email,
    created_by_username: j.created_by_username,
    created_by_display: j.created_by_display,
    created_by_is_shadow: j.created_by_is_shadow ?? false,
  })
  if (insertError) return { status: 'error', error: safeError(insertError, 'Failed to queue contact enrichment.') }

  await logActivity({
    action: 'enrichment.youtube_contact',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { pending_channels: pending, profile_country: loggedInCountry },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Queued contact enrichment (via the logged-in ${loggedInCountry} profile). A VM worker will open the top channels (by subscribers) through GoLogin and backfill website, socials, and the About-tab email. ${pending} channel${pending === 1 ? '' : 's'} still pending.`,
  }
}

// ============================================================
// YouTube Phase 3 — affiliate scoring + S-tag extraction / new-vs-known
//
// Pure data work (+ light HTTP to resolve affiliate redirect chains), so it
// runs INLINE like runKickStreamerAnalysis. For each channel it mines the
// recent video descriptions for affiliate tracking links, resolves them to
// an S-tag, checks each S-tag against Monday (search_s_tag_on_monday — the
// same RPC the lead s-tag dup-check uses), scores affiliate likelihood, and
// extracts outreach contacts. A channel is flagged is_new_lead_candidate
// when it's a likely affiliate whose CHANNEL isn't already on Monday — the
// dedup unit is the channel (its @handle), NOT the affiliate link it carries
// (Ryan, batch 1678). A channel we've already recorded is not "new" even when
// it promotes a not-yet-seen operator; a genuinely new channel IS new even
// when it shares an affiliate link with one we already have. The per-link
// known/new badge stays as informational intel in the "Affiliate links" column.
// No leads are created — the operator reviews the flagged candidates.
// ============================================================
export async function runYoutubeChannelAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'youtube') {
    return { status: 'error', error: 'Scoring only applies to YouTube scrape jobs.' }
  }

  type ChannelRow = {
    id: string
    channel_url: string
    channel_name: string | null
    channel_handle: string | null
    channel_description: string | null
    recent_video_descriptions: string[] | null
    website_url: string | null
    email: string | null
    twitter_url: string | null
    instagram_url: string | null
    tiktok_url: string | null
    telegram_url: string | null
    discord_url: string | null
  }
  const { data: channels, error: cErr } = await svc
    .from('youtube_channels')
    .select(
      'id, channel_url, channel_name, channel_handle, channel_description, recent_video_descriptions, website_url, email, ' +
        'twitter_url, instagram_url, tiktok_url, telegram_url, discord_url',
    )
    .eq('scrape_queue_id', jobId)
  if (cErr) return { status: 'error', error: safeError(cErr, 'Failed to load channels.') }
  const rows = (channels ?? []) as unknown as ChannelRow[]
  if (rows.length === 0) {
    return { status: 'ok', message: 'No channels to score yet — run the YouTube scrape first.' }
  }

  type LinkRow = {
    id: string
    youtube_channel_id: string
    url: string
    resolved_url: string | null
    s_tag: string | null
    is_known_on_monday: boolean | null
  }
  // Clean slate: drop this job's previously-mined links so a re-run re-derives
  // them deterministically (the resolved set + Monday verdicts can change, and
  // stale rows from an earlier run would otherwise linger un-rechecked).
  await svc.from('youtube_channel_links').delete().in('youtube_channel_id', rows.map(r => r.id))
  const linksByChannel = new Map<string, LinkRow[]>()

  // Casino-operator domain set (host suffixes) for affiliate-link scoring.
  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  let affiliateLinks = 0
  let withContacts = 0

  // Monday "have we seen this affiliate ID/operator?" check, memoized so the
  // same key across channels costs one RPC. Returns the match (or null).
  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // Insert a youtube_channel_links row (deduped per channel by its check key).
  // Returns true when the link's affiliate ID is NOT known on Monday (→ a
  // new-lead signal). The check key is the classic S-tag when we have one,
  // else the affiliate destination/operator brand — YouTube links are usually
  // redirectors with no in-URL stag, so the operator brand (vipclub,
  // dashcasinos, gamblemojo) is the dedup key we DO have. (Resolving the real
  // stag behind the redirector is the documented "stag later" follow-up.)
  async function storeLink(
    channelId: string,
    existing: LinkRow[],
    seen: Set<string>,
    row: { url: string; final_url: string; s_tag: string | null; s_tag_param: string | null; brand: string | null },
  ): Promise<boolean> {
    const checkKey = row.s_tag || row.brand || ''
    const dedupeKey = (checkKey || row.final_url).toLowerCase()
    if (seen.has(dedupeKey)) return false
    seen.add(dedupeKey)
    affiliateLinks++

    let isKnown: boolean | null = null
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) {
      hit = await checkMonday(checkKey)
      isKnown = !!hit
    }
    const { data: inserted } = await svc
      .from('youtube_channel_links')
      .insert({
        youtube_channel_id: channelId,
        url: row.url,
        source: 'video_description',
        resolved_url: row.final_url,
        resolved_at: new Date().toISOString(),
        s_tag: row.s_tag,
        s_tag_param: row.s_tag_param,
        brand: row.brand,
        is_known_on_monday: isKnown,
        monday_match_kind: hit?.kind ?? null,
        monday_match_item_id: hit?.item_id ?? null,
      })
      .select('id, youtube_channel_id, url, resolved_url, s_tag, is_known_on_monday')
      .maybeSingle()
    if (inserted) existing.push(inserted as unknown as LinkRow)
    return isKnown === false
  }

  // Per-channel state we carry from the shallow pass into the bounded two-hop
  // pass (so two-hop only fetches the likely affiliates' landing pages).
  type Pending = {
    c: ChannelRow
    links: LinkRow[]
    seen: Set<string>
    nicheScore: number
    likely: boolean
    twoHopUrl: string | null
  }
  const pendings: Pending[] = []

  // ---- Pass 1: shallow, every channel ----
  for (const c of rows) {
    const channelLinks = linksByChannel.get(c.id) ?? []
    // Dedupe key per stored link: its S-tag, else brand, else resolved URL.
    const seen = new Set(
      channelLinks
        .map(l => (l.s_tag || (l.resolved_url ?? l.url) || '').toLowerCase())
        .filter(Boolean),
    )

    // Collect + resolve the description's outbound affiliate candidates.
    const candidates = collectCandidates(
      [c.channel_description ?? '', ...(c.recent_video_descriptions ?? [])],
      c.website_url,
    )
    const resolved: ResolvedLink[] = []
    for (const cand of candidates) resolved.push(await resolveCandidate(cand, denylist))
    const casino = resolved.filter(r => r.is_casino)

    // Mine + store each casino link. storeLink computes the per-link
    // is_known_on_monday badge shown in the "Affiliate links" column; its
    // return value (link not on Monday) no longer drives the channel-level NEW
    // flag — that's decided by channel identity below.
    for (const r of casino) {
      await storeLink(c.id, channelLinks, seen, {
        url: r.source_url,
        final_url: r.final_url,
        s_tag: r.s_tag,
        s_tag_param: r.s_tag_param,
        brand: r.brand,
      })
    }

    // Score on the resolved casino destinations + name/keyword signals.
    const scoreLinks: YoutubeScoreLink[] = casino.map(r => ({ url: r.source_url, resolved_url: r.final_url }))
    const result = scoreYoutubeChannel(
      { channel_name: c.channel_name, channel_description: c.channel_description, recent_video_descriptions: c.recent_video_descriptions },
      scoreLinks,
      denylist,
    )

    // Contacts from text + resolved links (fills only what Phase 2 missed).
    const linkUrls = channelLinks.flatMap(l => [l.resolved_url, l.url].filter((u): u is string => !!u))
    if (c.website_url) linkUrls.push(c.website_url)
    const contacts = extractContacts(
      [c.channel_description ?? '', ...(c.recent_video_descriptions ?? [])],
      linkUrls,
    )

    // New-lead check: the dedup unit is the CHANNEL, not the affiliate link it
    // carries (Ryan, batch 1678). A channel is a new lead only when the channel
    // itself isn't already on Monday — what matters is whether THIS channel has
    // been captured before, regardless of whether its operator/S-tag is known.
    // Key on the @handle: Monday stores the full youtube.com/@handle URL, so the
    // @-prefixed form is precise enough to avoid matching a bare token inside an
    // unrelated item. Only worth checking for likely affiliates (non-affiliate
    // channels aren't leads). When the handle is missing/too short to verify, we
    // leave the channel un-flagged rather than guess — it still shows as a likely
    // affiliate, just without the NEW badge.
    let channelIsNew = false
    if (result.isLikelyAffiliate) {
      const handle = (c.channel_handle ?? '').replace(/^@/, '').trim()
      if (handle.length >= 3) {
        const known = await checkMonday(`@${handle}`)
        channelIsNew = !known
      }
    }

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      is_not_relevant: result.isNotRelevant,
      niche_score: result.nicheScore,
      is_new_lead_candidate: result.isLikelyAffiliate && channelIsNew,
    }
    if (!c.email && contacts.email) update.email = contacts.email
    if (!c.telegram_url && contacts.telegram_url) update.telegram_url = contacts.telegram_url
    if (!c.discord_url && contacts.discord_url) update.discord_url = contacts.discord_url
    if (!c.twitter_url && contacts.socials.twitter) update.twitter_url = contacts.socials.twitter
    if (!c.instagram_url && contacts.socials.instagram) update.instagram_url = contacts.socials.instagram
    if (!c.tiktok_url && contacts.socials.tiktok) update.tiktok_url = contacts.socials.tiktok

    const { error: upErr } = await svc.from('youtube_channels').update(update).eq('id', c.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (result.isLikelyAffiliate && channelIsNew) newCandidates++
    if (update.email || c.email || contacts.telegram_url || contacts.discord_url) withContacts++

    // A likely affiliate whose casino link is a landing/review PAGE with no
    // direct S-tag → queue it for the (bounded) two-hop pass.
    const twoHop = casino.find(r => r.two_hop_candidate)
    pendings.push({
      c, links: channelLinks, seen,
      nicheScore: result.nicheScore, likely: result.isLikelyAffiliate,
      twoHopUrl: twoHop?.final_url ?? null,
    })
  }

  // ---- Pass 2: two-hop, bounded to the strongest likely affiliates ----
  // Fetch the creator's review/landing page and mine ITS outbound casino
  // links for the real S-tags. Capped so the inline action stays well under
  // the function timeout (re-run to cover more).
  const TWO_HOP_CAP = 8
  const twoHopTargets = pendings
    .filter(p => p.likely && p.twoHopUrl)
    .sort((a, b) => b.nicheScore - a.nicheScore)
    .slice(0, TWO_HOP_CAP)

  for (const p of twoHopTargets) {
    const stags = await twoHopStags(p.twoHopUrl as string, { maxLinks: 10 })
    for (const t of stags) {
      // Mine + store the landing page's real S-tags (the per-link known/new
      // badge is still useful intel). This no longer flips the channel-level
      // NEW flag — that's decided solely by channel identity in pass 1, so a
      // known channel surfacing a new operator stays "not new".
      await storeLink(p.c.id, p.links, p.seen, {
        url: t.tracking_url,
        final_url: t.final_url,
        s_tag: t.s_tag,
        s_tag_param: t.source_param,
        brand: t.brand,
      })
    }
  }

  await logActivity({
    action: 'enrichment.youtube_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, withContacts },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} channel${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}${affiliateLinks > 0 ? `, ${affiliateLinks} affiliate link${affiliateLinks === 1 ? '' : 's'} captured` : ''}.`,
  }
}

// ============================================================
// X (x.com) Phase 2 — profile enrichment (operator-triggered ▶)
//
// Queues a browser scrape_queue job (search_engine='x' + parent_scrape_job_id)
// that a GoLogin worker claims and runs x_profile_scrape.py over: it renders
// each discovered x.com/{username} and backfills follower counts, bio, pinned
// tweet, website, socials, and the bio/pinned/website affiliate links. Mirrors
// runKickProfileEnrichment — same in-flight guard + lineage carry-over — but
// also pre-checks that the parent job's country profile is signed into X (both
// X phases run behind the login wall), so we don't burn a session that would
// just park on the login checkpoint.
// ============================================================
export async function runXProfileEnrichment(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd) // the parent Phase-1 X job
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: readErr } = await svc
    .from('scrape_queue')
    .select(
      'keyword, country_code, language, search_engine, created_by_email, created_by_username, created_by_display, created_by_is_shadow',
    )
    .eq('id', jobId)
    .maybeSingle()
  if (readErr) return { status: 'error', error: safeError(readErr, 'Failed to load the source job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  const j = job as {
    keyword: string
    country_code: string
    language: string | null
    search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | 'x' | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
  }
  if ((j.search_engine ?? '') !== 'x') {
    return { status: 'error', error: 'Profile enrichment only applies to X scrape jobs.' }
  }

  // Creators that haven't had their profile page scraped yet.
  const { count: pending, error: cntErr } = await svc
    .from('x_creators')
    .select('id', { count: 'exact', head: true })
    .eq('scrape_queue_id', jobId)
    .is('about_scraped_at', null)
    // Exclude rows already marked permanently failed — a re-run shouldn't
    // re-enqueue work for profiles that can never be enriched (mirrors the
    // VM-side work-list filter).
    .or('about_fetch_failed.is.null,about_fetch_failed.eq.false')
  if (cntErr) return { status: 'error', error: safeError(cntErr, 'Failed to count discovered creators.') }
  if (!pending || pending === 0) {
    revalidatePath(`/scrape/${jobId}`)
    return {
      status: 'ok',
      message: 'No creators left to enrich — every discovered profile has been scraped or marked unreachable.',
    }
  }

  // Don't stack Phase 2 jobs: bail if one is already queued/running for this
  // parent so a double-click doesn't burn two GoLogin sessions.
  const { count: inflight, error: ifErr } = await svc
    .from('scrape_queue')
    .select('id', { count: 'exact', head: true })
    .eq('parent_scrape_job_id', jobId)
    .in('status', ['pending', 'running'])
  if (ifErr) return { status: 'error', error: safeError(ifErr, 'Failed to check for an in-flight enrichment job.') }
  if (inflight && inflight > 0) {
    return { status: 'error', error: 'A profile-enrichment run is already queued or running for this job.' }
  }

  // Both X phases run behind the login wall, so the country's GoLogin profile
  // must be signed into the burner X account. Pre-check so we fail fast with a
  // clear message instead of enqueuing a job that just parks on the login
  // checkpoint. Phase 1 already ran under this country, so it's the right one.
  const { data: prof, error: profErr } = await svc
    .from('gologin_profiles')
    .select('is_x_logged_in')
    .eq('country_code', j.country_code)
    .eq('is_active', true)
    .not('gologin_profile_id', 'is', null)
    .maybeSingle()
  if (profErr) return { status: 'error', error: safeError(profErr, 'Failed to look up the X profile.') }
  if (!prof || (prof as { is_x_logged_in: boolean | null }).is_x_logged_in !== true) {
    return {
      status: 'error',
      error: `The ${j.country_code} GoLogin profile isn't signed into X — log the burner X account in via noVNC and set is_x_logged_in, then re-run.`,
    }
  }

  const { error: insertError } = await svc.from('scrape_queue').insert({
    keyword: j.keyword,
    country_code: j.country_code,
    search_engine: 'x',
    parent_scrape_job_id: jobId,
    language: j.language,
    priority: 0,
    with_enrichment: false,
    created_by_email: j.created_by_email,
    created_by_username: j.created_by_username,
    created_by_display: j.created_by_display,
    created_by_is_shadow: j.created_by_is_shadow ?? false,
  })
  if (insertError) return { status: 'error', error: safeError(insertError, 'Failed to queue profile enrichment.') }

  await logActivity({
    action: 'enrichment.x_profile',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { pending_creators: pending },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Queued profile enrichment. A VM worker will open the discovered profiles through GoLogin and backfill follower counts, bio, pinned tweet, website, socials, and affiliate links. ${pending} creator${pending === 1 ? '' : 's'} still pending.`,
  }
}

// ============================================================
// X (x.com) Phase 3 — affiliate scoring + S-tag / new-vs-known check
//
// Pure data work (+ light HTTP to resolve shorteners / redirect chains), so it
// runs INLINE like runKickStreamerAnalysis / runYoutubeChannelAnalysis. For
// each creator it resolves the bio/pinned/website links Phase 2 captured,
// parses any affiliate S-tag (or falls back to the operator brand), checks each
// against Monday (search_s_tag_on_monday), scores affiliate likelihood, and
// mines outreach contacts. A creator is flagged is_new_lead_candidate when it's
// a likely affiliate carrying ≥1 affiliate ID NOT on Monday, OR whose @handle
// isn't on Monday (X links are often redirectors with no in-URL stag — same
// stag-later design as YouTube). No leads are created — operator reviews them.
// ============================================================
export async function runXCreatorAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'x') {
    return { status: 'error', error: 'Scoring only applies to X scrape jobs.' }
  }

  type CreatorRow = {
    id: string
    username: string | null
    display_name: string | null
    bio: string | null
    pinned_tweet_text: string | null
    instagram_handle: string | null
    youtube_handle: string | null
    tiktok_handle: string | null
    facebook_handle: string | null
  }
  const { data: creators, error: cErr } = await svc
    .from('x_creators')
    .select(
      'id, username, display_name, bio, pinned_tweet_text, ' +
        'instagram_handle, youtube_handle, tiktok_handle, facebook_handle',
    )
    .eq('scrape_queue_id', jobId)
  if (cErr) return { status: 'error', error: safeError(cErr, 'Failed to load creators.') }
  const rows = (creators ?? []) as unknown as CreatorRow[]
  if (rows.length === 0) {
    return { status: 'ok', message: 'No creators to score yet — run the X scrape first.' }
  }
  const creatorIds = rows.map(r => r.id)

  type LinkRow = {
    id: string
    x_creator_id: string
    url: string
    resolved_url: string | null
    source: string
    s_tag: string | null
    brand: string | null
    is_known_on_monday: boolean | null
  }
  const { data: links, error: lErr } = await svc
    .from('x_links')
    .select('id, x_creator_id, url, resolved_url, source, s_tag, brand, is_known_on_monday')
    .in('x_creator_id', creatorIds)
  if (lErr) return { status: 'error', error: safeError(lErr, 'Failed to load creator links.') }
  const allLinks = (links ?? []) as unknown as LinkRow[]

  // Casino-operator domain set (host suffixes) for affiliate-link scoring.
  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  // 1. Resolve shortener-like links (bio/pinned links are usually t.co — a
  //    real shortener — so this expands them to the operator destination).
  const toResolve = allLinks
    .filter(l => !l.resolved_url && needsResolution(l.url))
    .map(l => l.url)
  let linksResolved = 0
  if (toResolve.length > 0) {
    const resolvedMap = await resolveShorteners(toResolve)
    const nowIso = new Date().toISOString()
    for (const l of allLinks) {
      const resolved = resolvedMap.get(l.url)
      if (!resolved) continue
      l.resolved_url = resolved // reflect locally so scoring/parsing sees it
      const { error: upErr } = await svc
        .from('x_links')
        .update({ resolved_url: resolved, resolved_at: nowIso })
        .eq('id', l.id)
      if (!upErr) linksResolved++
    }
  }

  // Monday "have we seen this affiliate ID / operator?" check, memoized so the
  // same key across creators costs one RPC.
  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // 2. Parse S-tag / brand for each casino link + check it against Monday,
  //    persisting the verdict on the x_links row (mirrors youtube_channel_links).
  const linksByCreator = new Map<string, LinkRow[]>()
  for (const l of allLinks) {
    const arr = linksByCreator.get(l.x_creator_id) ?? []
    arr.push(l)
    linksByCreator.set(l.x_creator_id, arr)
  }
  let affiliateLinks = 0
  for (const l of allLinks) {
    const dest = l.resolved_url ?? l.url
    const parsed = parseStagFromUrl(dest)
    const isCasino = !!parsed || isAffiliateCasinoLink(dest, denylist)
    if (!isCasino) continue
    affiliateLinks++
    const brand = guessBrandFromUrl(dest)
    const checkKey = parsed?.tag || brand || ''
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) hit = await checkMonday(checkKey)
    const update = {
      s_tag: parsed?.tag ?? null,
      s_tag_param: parsed?.param ?? null,
      brand,
      is_known_on_monday: checkKey ? !!hit : null,
      monday_match_kind: hit?.kind ?? null,
      monday_match_item_id: hit?.item_id ?? null,
    }
    const { error: upErr } = await svc.from('x_links').update(update).eq('id', l.id)
    if (!upErr) {
      l.s_tag = update.s_tag
      l.brand = update.brand
      l.is_known_on_monday = update.is_known_on_monday
    }
  }

  // 3. Score each creator + derive contacts + new-vs-known verdict.
  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  let withContacts = 0
  for (const c of rows) {
    const creatorLinks = linksByCreator.get(c.id) ?? []
    const scoreLinks: XScoreLink[] = creatorLinks.map(l => ({ url: l.url, resolved_url: l.resolved_url }))
    const result = scoreXCreator(
      { display_name: c.display_name, username: c.username, bio: c.bio, pinned_tweet_text: c.pinned_tweet_text },
      scoreLinks,
      denylist,
    )

    // Contacts from bio + pinned text + the captured link URLs (resolved first
    // so a t.co that expanded to a t.me/discord invite still counts). X exposes
    // no email, so this is mostly Telegram › Discord › socials.
    const linkUrls = creatorLinks.flatMap(l => [l.resolved_url, l.url].filter((u): u is string => !!u))
    const contacts = extractContacts([c.bio ?? '', c.pinned_tweet_text ?? ''], linkUrls)

    // New-lead check: a casino link whose affiliate ID/operator isn't on
    // Monday, OR the @handle itself isn't on Monday (only for likely affiliates).
    const hasNewTag = creatorLinks.some(l => l.is_known_on_monday === false)
    let handleIsNew = false
    let handleChecked = false
    if (result.isLikelyAffiliate) {
      const handle = (c.username ?? '').replace(/^@/, '').trim()
      if (handle.length >= 2) {
        const known = await checkMonday(handle)
        handleIsNew = !known
        handleChecked = true
      }
    }
    const isNewCandidate = result.isLikelyAffiliate && (hasNewTag || handleIsNew)

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      niche_score: result.nicheScore,
      is_new_lead_candidate: isNewCandidate,
      // Only assert known/unknown when Monday was actually queried — a likely
      // affiliate with a missing/too-short handle stays null (unknown) rather
      // than defaulting to "known".
      is_known_on_monday: result.isLikelyAffiliate && handleChecked ? !handleIsNew : null,
      contact_email: contacts.email,
      telegram_url: contacts.telegram_url,
      discord_url: contacts.discord_url,
    }
    // Fill only socials Phase 2 missed — never clobber a handle the profile
    // scrape already captured.
    if (!c.instagram_handle && contacts.socials.instagram) update.instagram_handle = contacts.socials.instagram
    if (!c.youtube_handle && contacts.socials.youtube) update.youtube_handle = contacts.socials.youtube
    if (!c.tiktok_handle && contacts.socials.tiktok) update.tiktok_handle = contacts.socials.tiktok
    if (!c.facebook_handle && contacts.socials.facebook) update.facebook_handle = contacts.socials.facebook

    const { error: upErr } = await svc.from('x_creators').update(update).eq('id', c.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (isNewCandidate) newCandidates++
    if (contacts.email || contacts.telegram_url || contacts.discord_url) withContacts++
  }

  await logActivity({
    action: 'enrichment.x_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, linksResolved, withContacts },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} creator${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}, ${withContacts} with contact${withContacts === 1 ? '' : 's'}${linksResolved > 0 ? `, ${linksResolved} link${linksResolved === 1 ? '' : 's'} resolved` : ''}.`,
  }
}

// ============================================================
// TikTok Phase 2 — operator-triggered profile enrichment.
//
// Mirrors runXProfileEnrichment but with NO login pre-check: TikTok serves
// profiles logged-out, so there's no burner-account / is_*_logged_in gate.
// Queues a child 'tiktok' job carrying parent_scrape_job_id; the VM worker
// renders each discovered profile and backfills bio / bio-link / followers /
// captions into tiktok_creators + tiktok_links.
// ============================================================
export async function runTiktokProfileEnrichment(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd) // the parent Phase-1 TikTok job
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: readErr } = await svc
    .from('scrape_queue')
    .select(
      'keyword, country_code, language, search_engine, created_by_email, created_by_username, created_by_display, created_by_is_shadow',
    )
    .eq('id', jobId)
    .maybeSingle()
  if (readErr) return { status: 'error', error: safeError(readErr, 'Failed to load the source job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  const j = job as {
    keyword: string
    country_code: string
    language: string | null
    search_engine: string | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
  }
  if ((j.search_engine ?? '') !== 'tiktok') {
    return { status: 'error', error: 'Profile enrichment only applies to TikTok scrape jobs.' }
  }

  // Creators that haven't had their profile page scraped yet.
  const { count: pending, error: cntErr } = await svc
    .from('tiktok_creators')
    .select('id', { count: 'exact', head: true })
    .eq('scrape_queue_id', jobId)
    .is('about_scraped_at', null)
    // Exclude rows already marked permanently failed — a re-run shouldn't
    // re-enqueue work for profiles that can never be enriched (mirrors the
    // VM-side work-list filter).
    .or('about_fetch_failed.is.null,about_fetch_failed.eq.false')
  if (cntErr) return { status: 'error', error: safeError(cntErr, 'Failed to count discovered creators.') }
  if (!pending || pending === 0) {
    revalidatePath(`/scrape/${jobId}`)
    return {
      status: 'ok',
      message: 'No creators left to enrich — every discovered profile has been scraped or marked unreachable.',
    }
  }

  // Don't stack Phase 2 jobs: bail if one is already queued/running for this
  // parent so a double-click doesn't burn two GoLogin sessions.
  const { count: inflight, error: ifErr } = await svc
    .from('scrape_queue')
    .select('id', { count: 'exact', head: true })
    .eq('parent_scrape_job_id', jobId)
    .in('status', ['pending', 'running'])
  if (ifErr) return { status: 'error', error: safeError(ifErr, 'Failed to check for an in-flight enrichment job.') }
  if (inflight && inflight > 0) {
    return { status: 'error', error: 'A profile-enrichment run is already queued or running for this job.' }
  }

  // No login pre-check (unlike X): TikTok serves profiles logged-out.
  const { error: insertError } = await svc.from('scrape_queue').insert({
    keyword: j.keyword,
    country_code: j.country_code,
    search_engine: 'tiktok',
    parent_scrape_job_id: jobId,
    language: j.language,
    priority: 0,
    with_enrichment: false,
    created_by_email: j.created_by_email,
    created_by_username: j.created_by_username,
    created_by_display: j.created_by_display,
    created_by_is_shadow: j.created_by_is_shadow ?? false,
  })
  if (insertError) return { status: 'error', error: safeError(insertError, 'Failed to queue profile enrichment.') }

  await logActivity({
    action: 'enrichment.tiktok_profile',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { pending_creators: pending },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Queued profile enrichment. A VM worker will open the discovered profiles through GoLogin and backfill bio, bio link, followers, and recent captions. ${pending} creator${pending === 1 ? '' : 's'} still pending.`,
  }
}

// ============================================================
// TikTok Phase 3 — affiliate scoring + S-tag / new-vs-known check
//
// Pure data work (+ light HTTP to resolve shorteners), so it runs INLINE like
// runXCreatorAnalysis. For each creator it resolves the bio-link + caption
// links Phase 2 captured, parses any affiliate S-tag (or falls back to the
// operator brand), checks each against Monday, scores affiliate likelihood
// from the bio link (hub/shortener/casino) + bio/caption keywords + handle, and
// mines outreach contacts. A creator is flagged is_new_lead_candidate when it's
// a likely affiliate carrying ≥1 affiliate ID NOT on Monday, OR whose @handle
// isn't on Monday (TikTok bio links are usually redirectors with no in-URL stag).
// No leads are created — operator reviews them.
// ============================================================
export async function runTiktokCreatorAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'tiktok') {
    return { status: 'error', error: 'Scoring only applies to TikTok scrape jobs.' }
  }

  type CreatorRow = {
    id: string
    username: string | null
    display_name: string | null
    bio: string | null
    recent_video_captions: string[] | null
  }
  const { data: creators, error: cErr } = await svc
    .from('tiktok_creators')
    .select('id, username, display_name, bio, recent_video_captions')
    .eq('scrape_queue_id', jobId)
  if (cErr) return { status: 'error', error: safeError(cErr, 'Failed to load creators.') }
  const rows = (creators ?? []) as unknown as CreatorRow[]
  if (rows.length === 0) {
    return { status: 'ok', message: 'No creators to score yet — run the TikTok scrape first.' }
  }
  const creatorIds = rows.map(r => r.id)

  type LinkRow = {
    id: string
    tiktok_creator_id: string
    url: string
    resolved_url: string | null
    source: string
    s_tag: string | null
    brand: string | null
    is_known_on_monday: boolean | null
  }
  const { data: links, error: lErr } = await svc
    .from('tiktok_links')
    .select('id, tiktok_creator_id, url, resolved_url, source, s_tag, brand, is_known_on_monday')
    .in('tiktok_creator_id', creatorIds)
  if (lErr) return { status: 'error', error: safeError(lErr, 'Failed to load creator links.') }
  const allLinks = (links ?? []) as unknown as LinkRow[]

  // Casino-operator domain set (host suffixes) for affiliate-link scoring.
  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  // 1. Resolve shortener-like links (bio links are often a tny.sh/bit.ly mask —
  //    expand to the operator destination).
  const toResolve = allLinks
    .filter(l => !l.resolved_url && needsResolution(l.url))
    .map(l => l.url)
  let linksResolved = 0
  if (toResolve.length > 0) {
    const resolvedMap = await resolveShorteners(toResolve)
    const nowIso = new Date().toISOString()
    for (const l of allLinks) {
      const resolved = resolvedMap.get(l.url)
      if (!resolved) continue
      l.resolved_url = resolved // reflect locally so scoring/parsing sees it
      const { error: upErr } = await svc
        .from('tiktok_links')
        .update({ resolved_url: resolved, resolved_at: nowIso })
        .eq('id', l.id)
      if (!upErr) linksResolved++
    }
  }

  // Monday "have we seen this affiliate ID / operator?" check, memoized.
  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // 2. Parse S-tag / brand for each casino link + check it against Monday.
  const linksByCreator = new Map<string, LinkRow[]>()
  for (const l of allLinks) {
    const arr = linksByCreator.get(l.tiktok_creator_id) ?? []
    arr.push(l)
    linksByCreator.set(l.tiktok_creator_id, arr)
  }
  let affiliateLinks = 0
  for (const l of allLinks) {
    const dest = l.resolved_url ?? l.url
    const parsed = parseStagFromUrl(dest)
    const isCasino = !!parsed || isAffiliateCasinoLink(dest, denylist)
    if (!isCasino) continue
    affiliateLinks++
    const brand = guessBrandFromUrl(dest)
    const checkKey = parsed?.tag || brand || ''
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) hit = await checkMonday(checkKey)
    const update = {
      s_tag: parsed?.tag ?? null,
      s_tag_param: parsed?.param ?? null,
      brand,
      is_known_on_monday: checkKey ? !!hit : null,
      monday_match_kind: hit?.kind ?? null,
      monday_match_item_id: hit?.item_id ?? null,
    }
    const { error: upErr } = await svc.from('tiktok_links').update(update).eq('id', l.id)
    if (!upErr) {
      l.s_tag = update.s_tag
      l.brand = update.brand
      l.is_known_on_monday = update.is_known_on_monday
    }
  }

  // 3. Score each creator + derive contacts + new-vs-known verdict.
  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  let withContacts = 0
  for (const c of rows) {
    const creatorLinks = linksByCreator.get(c.id) ?? []
    const scoreLinks: TiktokScoreLink[] = creatorLinks.map(l => ({ url: l.url, resolved_url: l.resolved_url }))
    const result = scoreTiktokCreator(
      { display_name: c.display_name, username: c.username, bio: c.bio, captions: c.recent_video_captions },
      scoreLinks,
      denylist,
    )

    // Contacts from bio + captions + the captured link URLs (resolved first so a
    // shortener that expanded to a t.me/discord invite still counts). TikTok
    // exposes no email field, so this is mostly Telegram › Discord, plus any
    // email written in the bio.
    const linkUrls = creatorLinks.flatMap(l => [l.resolved_url, l.url].filter((u): u is string => !!u))
    const contacts = extractContacts([c.bio ?? '', ...(c.recent_video_captions ?? [])], linkUrls)

    // New-lead check: a casino link whose affiliate ID/operator isn't on
    // Monday, OR the @handle itself isn't on Monday (only for likely affiliates).
    const hasNewTag = creatorLinks.some(l => l.is_known_on_monday === false)
    let handleIsNew = false
    let handleChecked = false
    if (result.isLikelyAffiliate) {
      const handle = (c.username ?? '').replace(/^@/, '').trim()
      if (handle.length >= 2) {
        const known = await checkMonday(handle)
        handleIsNew = !known
        handleChecked = true
      }
    }
    const isNewCandidate = result.isLikelyAffiliate && (hasNewTag || handleIsNew)

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      niche_score: result.nicheScore,
      is_new_lead_candidate: isNewCandidate,
      // Only assert known/unknown when Monday was actually queried — a likely
      // affiliate with a missing/too-short handle stays null (unknown) rather
      // than defaulting to "known".
      is_known_on_monday: result.isLikelyAffiliate && handleChecked ? !handleIsNew : null,
      contact_email: contacts.email,
      telegram_url: contacts.telegram_url,
      discord_url: contacts.discord_url,
    }

    const { error: upErr } = await svc.from('tiktok_creators').update(update).eq('id', c.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (isNewCandidate) newCandidates++
    if (contacts.email || contacts.telegram_url || contacts.discord_url) withContacts++
  }

  await logActivity({
    action: 'enrichment.tiktok_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, linksResolved, withContacts },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} creator${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}, ${withContacts} with contact${withContacts === 1 ? '' : 's'}${linksResolved > 0 ? `, ${linksResolved} link${linksResolved === 1 ? '' : 's'} resolved` : ''}.`,
  }
}

// ============================================================
// Snapchat Phase 3 — affiliate scoring + S-tag / new-vs-known check
//
// Snapchat is single-pass (snapchat_search.py discovers AND enriches), so there
// is NO separate profile-enrichment action — only this inline scorer, like the
// Facebook engine's score-only flow. For each creator it resolves the bio link
// the scrape captured, parses any affiliate S-tag (or falls back to the operator
// brand), checks each against Monday, scores affiliate likelihood from the bio
// link (hub/shortener/casino) + bio keywords + handle, and mines contacts. A
// creator is flagged is_new_lead_candidate when it's a likely affiliate carrying
// ≥1 affiliate ID NOT on Monday, OR whose @handle isn't on Monday.
// ============================================================
export async function runSnapchatCreatorAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'snapchat') {
    return { status: 'error', error: 'Scoring only applies to Snapchat scrape jobs.' }
  }

  type CreatorRow = {
    id: string
    username: string | null
    display_name: string | null
    bio: string | null
  }
  const { data: creators, error: cErr } = await svc
    .from('snapchat_creators')
    .select('id, username, display_name, bio')
    .eq('scrape_queue_id', jobId)
  if (cErr) return { status: 'error', error: safeError(cErr, 'Failed to load creators.') }
  const rows = (creators ?? []) as unknown as CreatorRow[]
  if (rows.length === 0) {
    return { status: 'ok', message: 'No creators to score yet — run the Snapchat scrape first.' }
  }
  const creatorIds = rows.map(r => r.id)

  type LinkRow = {
    id: string
    snapchat_creator_id: string
    url: string
    resolved_url: string | null
    source: string
    s_tag: string | null
    brand: string | null
    is_known_on_monday: boolean | null
  }
  const { data: links, error: lErr } = await svc
    .from('snapchat_links')
    .select('id, snapchat_creator_id, url, resolved_url, source, s_tag, brand, is_known_on_monday')
    .in('snapchat_creator_id', creatorIds)
  if (lErr) return { status: 'error', error: safeError(lErr, 'Failed to load creator links.') }
  const allLinks = (links ?? []) as unknown as LinkRow[]

  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  // 1. Resolve shortener-like bio links.
  const toResolve = allLinks
    .filter(l => !l.resolved_url && needsResolution(l.url))
    .map(l => l.url)
  let linksResolved = 0
  if (toResolve.length > 0) {
    const resolvedMap = await resolveShorteners(toResolve)
    const nowIso = new Date().toISOString()
    for (const l of allLinks) {
      const resolved = resolvedMap.get(l.url)
      if (!resolved) continue
      l.resolved_url = resolved
      const { error: upErr } = await svc
        .from('snapchat_links')
        .update({ resolved_url: resolved, resolved_at: nowIso })
        .eq('id', l.id)
      if (!upErr) linksResolved++
    }
  }

  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // 2. Parse S-tag / brand for each casino link + check it against Monday.
  const linksByCreator = new Map<string, LinkRow[]>()
  for (const l of allLinks) {
    const arr = linksByCreator.get(l.snapchat_creator_id) ?? []
    arr.push(l)
    linksByCreator.set(l.snapchat_creator_id, arr)
  }
  let affiliateLinks = 0
  for (const l of allLinks) {
    const dest = l.resolved_url ?? l.url
    const parsed = parseStagFromUrl(dest)
    const isCasino = !!parsed || isAffiliateCasinoLink(dest, denylist)
    if (!isCasino) continue
    affiliateLinks++
    const brand = guessBrandFromUrl(dest)
    const checkKey = parsed?.tag || brand || ''
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) hit = await checkMonday(checkKey)
    const update = {
      s_tag: parsed?.tag ?? null,
      s_tag_param: parsed?.param ?? null,
      brand,
      is_known_on_monday: checkKey ? !!hit : null,
      monday_match_kind: hit?.kind ?? null,
      monday_match_item_id: hit?.item_id ?? null,
    }
    const { error: upErr } = await svc.from('snapchat_links').update(update).eq('id', l.id)
    if (!upErr) {
      l.s_tag = update.s_tag
      l.brand = update.brand
      l.is_known_on_monday = update.is_known_on_monday
    }
  }

  // 3. Score each creator + derive contacts + new-vs-known verdict.
  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  let withContacts = 0
  for (const c of rows) {
    const creatorLinks = linksByCreator.get(c.id) ?? []
    const scoreLinks: SnapchatScoreLink[] = creatorLinks.map(l => ({ url: l.url, resolved_url: l.resolved_url }))
    const result = scoreSnapchatCreator(
      { display_name: c.display_name, username: c.username, bio: c.bio },
      scoreLinks,
      denylist,
    )

    const linkUrls = creatorLinks.flatMap(l => [l.resolved_url, l.url].filter((u): u is string => !!u))
    const contacts = extractContacts([c.bio ?? ''], linkUrls)

    const hasNewTag = creatorLinks.some(l => l.is_known_on_monday === false)
    let handleIsNew = false
    let handleChecked = false
    if (result.isLikelyAffiliate) {
      const handle = (c.username ?? '').replace(/^@/, '').trim()
      if (handle.length >= 2) {
        const known = await checkMonday(handle)
        handleIsNew = !known
        handleChecked = true
      }
    }
    const isNewCandidate = result.isLikelyAffiliate && (hasNewTag || handleIsNew)

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      is_not_relevant: result.isNotRelevant,
      niche_score: result.nicheScore,
      is_new_lead_candidate: isNewCandidate,
      // Only assert known/unknown when Monday was actually queried — a likely
      // affiliate with a missing/too-short handle stays null (unknown) rather
      // than defaulting to "known".
      is_known_on_monday: result.isLikelyAffiliate && handleChecked ? !handleIsNew : null,
      contact_email: contacts.email,
      telegram_url: contacts.telegram_url,
      discord_url: contacts.discord_url,
    }

    const { error: upErr } = await svc.from('snapchat_creators').update(update).eq('id', c.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (isNewCandidate) newCandidates++
    if (contacts.email || contacts.telegram_url || contacts.discord_url) withContacts++
  }

  await logActivity({
    action: 'enrichment.snapchat_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, linksResolved, withContacts },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} creator${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}, ${withContacts} with contact${withContacts === 1 ? '' : 's'}${linksResolved > 0 ? `, ${linksResolved} link${linksResolved === 1 ? '' : 's'} resolved` : ''}.`,
  }
}

// ============================================================
// Twitch Phase 3 — affiliate scoring + S-tag / new-vs-known check
//
// Twitch is single-pass (twitch_search.py discovers via Helix AND enriches
// VODs/clips/About-panels in one run), so — like Snapchat/Telegram — the only
// operator action is this inline scorer. For each streamer it resolves the
// captured links, parses any affiliate S-tag (or falls back to the operator
// brand), checks each against Monday, scores affiliate likelihood from the
// panel/bio casino links + title/bio keywords + gambling game/tags, and flags
// is_new_lead_candidate when a likely affiliate carries an affiliate ID NOT on
// Monday OR whose @login isn't on Monday. Contacts (email / Telegram / Discord)
// are mined from the bio + panels at scrape time in twitch_search.py, so —
// like Kick/Snapchat — there's no separate contact pass here.
// ============================================================
export async function runTwitchStreamerAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'twitch') {
    return { status: 'error', error: 'Scoring only applies to Twitch scrape jobs.' }
  }

  type StreamerRow = {
    id: string
    broadcaster_login: string | null
    display_name: string | null
    bio: string | null
    stream_title: string | null
    tags: string[] | null
    game_name: string | null
  }
  const { data: streamers, error: sErr } = await svc
    .from('twitch_streamers')
    .select('id, broadcaster_login, display_name, bio, stream_title, tags, game_name')
    .eq('scrape_queue_id', jobId)
  if (sErr) return { status: 'error', error: safeError(sErr, 'Failed to load streamers.') }
  const rows = (streamers ?? []) as unknown as StreamerRow[]
  if (rows.length === 0) {
    return { status: 'ok', message: 'No streamers to score yet — run the Twitch scrape first.' }
  }
  const streamerIds = rows.map(r => r.id)

  type LinkRow = {
    id: string
    twitch_streamer_id: string
    url: string
    resolved_url: string | null
    source: string
    s_tag: string | null
    brand: string | null
    is_known_on_monday: boolean | null
  }
  const { data: links, error: lErr } = await svc
    .from('twitch_links')
    .select('id, twitch_streamer_id, url, resolved_url, source, s_tag, brand, is_known_on_monday')
    .in('twitch_streamer_id', streamerIds)
  if (lErr) return { status: 'error', error: safeError(lErr, 'Failed to load streamer links.') }
  const allLinks = (links ?? []) as unknown as LinkRow[]

  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  // 1. Resolve shortener-like links.
  const toResolve = allLinks
    .filter(l => !l.resolved_url && needsResolution(l.url))
    .map(l => l.url)
  let linksResolved = 0
  if (toResolve.length > 0) {
    const resolvedMap = await resolveShorteners(toResolve)
    const nowIso = new Date().toISOString()
    for (const l of allLinks) {
      const resolved = resolvedMap.get(l.url)
      if (!resolved) continue
      l.resolved_url = resolved
      const { error: upErr } = await svc
        .from('twitch_links')
        .update({ resolved_url: resolved, resolved_at: nowIso })
        .eq('id', l.id)
      if (!upErr) linksResolved++
    }
  }

  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // 2. Parse S-tag / brand for each casino link + check it against Monday.
  const linksByStreamer = new Map<string, LinkRow[]>()
  for (const l of allLinks) {
    const arr = linksByStreamer.get(l.twitch_streamer_id) ?? []
    arr.push(l)
    linksByStreamer.set(l.twitch_streamer_id, arr)
  }
  let affiliateLinks = 0
  for (const l of allLinks) {
    const dest = l.resolved_url ?? l.url
    const parsed = parseStagFromUrl(dest)
    const isCasino = !!parsed || isAffiliateCasinoLink(dest, denylist)
    if (!isCasino) continue
    affiliateLinks++
    const brand = guessBrandFromUrl(dest)
    const checkKey = parsed?.tag || brand || ''
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) hit = await checkMonday(checkKey)
    const update = {
      s_tag: parsed?.tag ?? null,
      s_tag_param: parsed?.param ?? null,
      brand,
      is_known_on_monday: checkKey ? !!hit : null,
      monday_match_kind: hit?.kind ?? null,
      monday_match_item_id: hit?.item_id ?? null,
    }
    const { error: upErr } = await svc.from('twitch_links').update(update).eq('id', l.id)
    if (!upErr) {
      l.s_tag = update.s_tag
      l.brand = update.brand
      l.is_known_on_monday = update.is_known_on_monday
    }
  }

  // 3. Score each streamer + derive the new-vs-known verdict.
  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  for (const s of rows) {
    const streamerLinks = linksByStreamer.get(s.id) ?? []
    const scoreLinks: TwitchScoreLink[] = streamerLinks.map(l => ({
      url: l.url,
      resolved_url: l.resolved_url,
      source: l.source,
      brand: l.brand,
    }))
    const result = scoreTwitchStreamer(
      { bio: s.bio, stream_title: s.stream_title, tags: s.tags, game_name: s.game_name },
      scoreLinks,
      denylist,
    )

    const hasNewTag = streamerLinks.some(l => l.is_known_on_monday === false)
    let handleIsNew = false
    let handleChecked = false
    if (result.isLikelyAffiliate) {
      const handle = (s.broadcaster_login ?? '').replace(/^@/, '').trim()
      if (handle.length >= 2) {
        const known = await checkMonday(handle)
        handleIsNew = !known
        handleChecked = true
      }
    }
    const isNewCandidate = result.isLikelyAffiliate && (hasNewTag || handleIsNew)

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      niche_score: result.nicheScore,
      is_new_lead_candidate: isNewCandidate,
      is_known_on_monday: result.isLikelyAffiliate && handleChecked ? !handleIsNew : null,
    }

    const { error: upErr } = await svc.from('twitch_streamers').update(update).eq('id', s.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (isNewCandidate) newCandidates++
  }

  await logActivity({
    action: 'enrichment.twitch_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, linksResolved },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} streamer${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}${linksResolved > 0 ? `, ${linksResolved} link${linksResolved === 1 ? '' : 's'} resolved` : ''}.`,
  }
}

// ============================================================
// Telegram Phase 3 — affiliate scoring + S-tag / new-vs-known check
//
// Telegram is single-pass (telegram_search.py discovers AND enriches via
// t.me/s), so — like Snapchat/Facebook — the only operator action is this
// inline scorer. For each channel it resolves the links it posts, parses any
// affiliate S-tag (or falls back to the operator brand), checks each against
// Monday, scores affiliate likelihood from the posted casino links + title/
// description keywords + handle, and mines contacts. A channel is flagged
// is_new_lead_candidate when it's a likely affiliate carrying ≥1 affiliate ID
// NOT on Monday, OR whose @handle isn't on Monday.
// ============================================================
export async function runTelegramChannelAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'telegram') {
    return { status: 'error', error: 'Scoring only applies to Telegram scrape jobs.' }
  }

  type ChannelRow = {
    id: string
    username: string | null
    title: string | null
    description: string | null
  }
  const { data: channels, error: cErr } = await svc
    .from('telegram_channels')
    .select('id, username, title, description')
    .eq('scrape_queue_id', jobId)
  if (cErr) return { status: 'error', error: safeError(cErr, 'Failed to load channels.') }
  const rows = (channels ?? []) as unknown as ChannelRow[]
  if (rows.length === 0) {
    return { status: 'ok', message: 'No channels to score yet — run the Telegram scrape first.' }
  }
  const channelIds = rows.map(r => r.id)

  type LinkRow = {
    id: string
    telegram_channel_id: string
    url: string
    resolved_url: string | null
    source: string
    s_tag: string | null
    brand: string | null
    is_known_on_monday: boolean | null
  }
  const { data: links, error: lErr } = await svc
    .from('telegram_links')
    .select('id, telegram_channel_id, url, resolved_url, source, s_tag, brand, is_known_on_monday')
    .in('telegram_channel_id', channelIds)
  if (lErr) return { status: 'error', error: safeError(lErr, 'Failed to load channel links.') }
  const allLinks = (links ?? []) as unknown as LinkRow[]

  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  // 1. Resolve shortener-like posted links.
  const toResolve = allLinks
    .filter(l => !l.resolved_url && needsResolution(l.url))
    .map(l => l.url)
  let linksResolved = 0
  if (toResolve.length > 0) {
    const resolvedMap = await resolveShorteners(toResolve)
    const nowIso = new Date().toISOString()
    for (const l of allLinks) {
      const resolved = resolvedMap.get(l.url)
      if (!resolved) continue
      l.resolved_url = resolved
      const { error: upErr } = await svc
        .from('telegram_links')
        .update({ resolved_url: resolved, resolved_at: nowIso })
        .eq('id', l.id)
      if (!upErr) linksResolved++
    }
  }

  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // 2. Parse S-tag / brand for each casino link + check it against Monday.
  const linksByChannel = new Map<string, LinkRow[]>()
  for (const l of allLinks) {
    const arr = linksByChannel.get(l.telegram_channel_id) ?? []
    arr.push(l)
    linksByChannel.set(l.telegram_channel_id, arr)
  }
  let affiliateLinks = 0
  for (const l of allLinks) {
    const dest = l.resolved_url ?? l.url
    const parsed = parseStagFromUrl(dest)
    const isCasino = !!parsed || isAffiliateCasinoLink(dest, denylist)
    if (!isCasino) continue
    affiliateLinks++
    const brand = guessBrandFromUrl(dest)
    const checkKey = parsed?.tag || brand || ''
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) hit = await checkMonday(checkKey)
    const update = {
      s_tag: parsed?.tag ?? null,
      s_tag_param: parsed?.param ?? null,
      brand,
      is_known_on_monday: checkKey ? !!hit : null,
      monday_match_kind: hit?.kind ?? null,
      monday_match_item_id: hit?.item_id ?? null,
    }
    const { error: upErr } = await svc.from('telegram_links').update(update).eq('id', l.id)
    if (!upErr) {
      l.s_tag = update.s_tag
      l.brand = update.brand
      l.is_known_on_monday = update.is_known_on_monday
    }
  }

  // 3. Score each channel + derive contacts + new-vs-known verdict.
  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  let withContacts = 0
  for (const c of rows) {
    const channelLinks = linksByChannel.get(c.id) ?? []
    const scoreLinks: TelegramScoreLink[] = channelLinks.map(l => ({ url: l.url, resolved_url: l.resolved_url }))
    const result = scoreTelegramChannel(
      { title: c.title, username: c.username, description: c.description },
      scoreLinks,
      denylist,
    )

    const linkUrls = channelLinks.flatMap(l => [l.resolved_url, l.url].filter((u): u is string => !!u))
    const contacts = extractContacts([c.title ?? '', c.description ?? ''], linkUrls)

    const hasNewTag = channelLinks.some(l => l.is_known_on_monday === false)
    let handleIsNew = false
    let handleChecked = false
    if (result.isLikelyAffiliate) {
      const handle = (c.username ?? '').replace(/^@/, '').trim()
      if (handle.length >= 2) {
        const known = await checkMonday(handle)
        handleIsNew = !known
        handleChecked = true
      }
    }
    const isNewCandidate = result.isLikelyAffiliate && (hasNewTag || handleIsNew)

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      niche_score: result.nicheScore,
      is_new_lead_candidate: isNewCandidate,
      // Only assert known/unknown when Monday was actually queried — a likely
      // affiliate with a missing/too-short handle stays null (unknown) rather
      // than defaulting to "known".
      is_known_on_monday: result.isLikelyAffiliate && handleChecked ? !handleIsNew : null,
      contact_email: contacts.email,
      telegram_url: contacts.telegram_url,
      discord_url: contacts.discord_url,
    }

    const { error: upErr } = await svc.from('telegram_channels').update(update).eq('id', c.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (isNewCandidate) newCandidates++
    if (contacts.email || contacts.telegram_url || contacts.discord_url) withContacts++
  }

  await logActivity({
    action: 'enrichment.telegram_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, linksResolved, withContacts },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} channel${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}, ${withContacts} with contact${withContacts === 1 ? '' : 's'}${linksResolved > 0 ? `, ${linksResolved} link${linksResolved === 1 ? '' : 's'} resolved` : ''}.`,
  }
}

// ============================================================
// Facebook Ad Library Phase 3 — affiliate scoring + S-tag / new-vs-known check
//
// Pure data work (+ light HTTP to resolve shorteners), so it runs INLINE like
// runXCreatorAnalysis. For each advertiser it resolves the ad landing links
// the discovery scrape captured, parses any affiliate S-tag (or falls back to the operator
// brand), checks each against Monday (search_s_tag_on_monday), scores affiliate
// likelihood from the casino links + ad copy + Page name, and mines outreach
// contacts. An advertiser is flagged is_new_lead_candidate when it's a likely
// affiliate carrying ≥1 affiliate ID NOT on Monday, OR whose page_name isn't on
// Monday. No leads are created — the operator reviews them.
// ============================================================
export async function runFbAdvertiserAnalysis(
  _prev: StageRunState,
  fd: FormData,
): Promise<StageRunState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const svc = createServiceClient()

  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('search_engine')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) return { status: 'error', error: safeError(jobErr, 'Failed to load the job.') }
  if (!job) return { status: 'error', error: 'Job not found.' }
  if (((job as { search_engine: string | null }).search_engine ?? '') !== 'facebook') {
    return { status: 'error', error: 'Scoring only applies to Facebook scrape jobs.' }
  }

  type AdvertiserRow = {
    id: string
    page_name: string | null
    page_category: string | null
    ad_text_sample: string | null
    page_website_url: string | null
    page_transparency: string | null
  }
  const { data: advertisers, error: aErr } = await svc
    .from('fb_advertisers')
    .select('id, page_name, page_category, ad_text_sample, page_website_url, page_transparency')
    .eq('scrape_queue_id', jobId)
  if (aErr) return { status: 'error', error: safeError(aErr, 'Failed to load advertisers.') }
  const rows = (advertisers ?? []) as unknown as AdvertiserRow[]
  if (rows.length === 0) {
    return { status: 'ok', message: 'No advertisers to score yet — run the Facebook scrape first.' }
  }
  const advertiserIds = rows.map(r => r.id)

  type LinkRow = {
    id: string
    fb_advertiser_id: string
    url: string
    resolved_url: string | null
    source: string
    s_tag: string | null
    brand: string | null
    is_known_on_monday: boolean | null
  }
  const { data: links, error: lErr } = await svc
    .from('fb_links')
    .select('id, fb_advertiser_id, url, resolved_url, source, s_tag, brand, is_known_on_monday')
    .in('fb_advertiser_id', advertiserIds)
  if (lErr) return { status: 'error', error: safeError(lErr, 'Failed to load advertiser links.') }
  const allLinks = (links ?? []) as unknown as LinkRow[]

  // Casino-operator domain set (host suffixes) for affiliate-link scoring.
  const { data: denyRows } = await svc.from('operator_domains_denylist').select('host_suffix')
  const denylist = new Set(
    (denyRows ?? []).map(r => (r as { host_suffix: string }).host_suffix.toLowerCase()),
  )

  // 1. Resolve shortener-like links (FB ad CTAs frequently point at bit.ly /
  //    the affiliate /go/ redirector — expand to the operator destination).
  const toResolve = allLinks
    .filter(l => !l.resolved_url && needsResolution(l.url))
    .map(l => l.url)
  let linksResolved = 0
  if (toResolve.length > 0) {
    const resolvedMap = await resolveShorteners(toResolve)
    const nowIso = new Date().toISOString()
    for (const l of allLinks) {
      const resolved = resolvedMap.get(l.url)
      if (!resolved) continue
      l.resolved_url = resolved // reflect locally so scoring/parsing sees it
      const { error: upErr } = await svc
        .from('fb_links')
        .update({ resolved_url: resolved, resolved_at: nowIso })
        .eq('id', l.id)
      if (!upErr) linksResolved++
    }
  }

  // Monday "have we seen this affiliate ID / operator?" check, memoized so the
  // same key across advertisers costs one RPC.
  const mondayCache = new Map<string, { kind: string; item_id: string } | null>()
  async function checkMonday(key0: string): Promise<{ kind: string; item_id: string } | null> {
    const key = key0.toLowerCase()
    if (mondayCache.has(key)) return mondayCache.get(key) ?? null
    const { data } = await svc.rpc('search_s_tag_on_monday', { p_tag: key0 })
    const hit = (Array.isArray(data) ? data[0] : data) as { kind: string; item_id: string } | null | undefined
    const val = hit?.item_id ? hit : null
    mondayCache.set(key, val)
    return val
  }

  // 2. Parse S-tag / brand for each casino link + check it against Monday,
  //    persisting the verdict on the fb_links row (mirrors x_links).
  const linksByAdvertiser = new Map<string, LinkRow[]>()
  for (const l of allLinks) {
    const arr = linksByAdvertiser.get(l.fb_advertiser_id) ?? []
    arr.push(l)
    linksByAdvertiser.set(l.fb_advertiser_id, arr)
  }
  let affiliateLinks = 0
  for (const l of allLinks) {
    const dest = l.resolved_url ?? l.url
    const parsed = parseStagFromUrl(dest)
    const isCasino = !!parsed || isAffiliateCasinoLink(dest, denylist)
    if (!isCasino) continue
    affiliateLinks++
    const brand = guessBrandFromUrl(dest)
    const checkKey = parsed?.tag || brand || ''
    let hit: { kind: string; item_id: string } | null = null
    if (checkKey) hit = await checkMonday(checkKey)
    const update = {
      s_tag: parsed?.tag ?? null,
      s_tag_param: parsed?.param ?? null,
      brand,
      is_known_on_monday: checkKey ? !!hit : null,
      monday_match_kind: hit?.kind ?? null,
      monday_match_item_id: hit?.item_id ?? null,
    }
    const { error: upErr } = await svc.from('fb_links').update(update).eq('id', l.id)
    if (!upErr) {
      l.s_tag = update.s_tag
      l.brand = update.brand
      l.is_known_on_monday = update.is_known_on_monday
    }
  }

  // 3. Score each advertiser + derive contacts + new-vs-known verdict.
  const hostOf = (u: string): string => {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  // Affiliate referral code in a link path (.../RFOGAD007) — marks a link whose
  // destination is the casino the advertiser PROMOTES, not their own site.
  const AFFILIATE_REF_RE = /\/RF[A-Z0-9]{4,}/i
  const isFunnelLink = (l: LinkRow): boolean =>
    needsResolution(l.url) || // original was a shortener (tny.sh/…) — masks the operator
    AFFILIATE_REF_RE.test(l.url) ||
    AFFILIATE_REF_RE.test(l.resolved_url ?? '')

  // Pick the best contact-bearing page to fetch for an advertiser: their own
  // affiliate link-hub first (heylink/linktr — where affiliates publish their
  // email/Telegram), then the advertiser's OWN site (a direct, non-funnel link).
  // We deliberately SKIP affiliate-funnel destinations (shortener / referral-code
  // links): those land on the casino operator the advertiser promotes, whose
  // support@ address is the wrong outreach party — not the affiliate. Returns
  // null when there's nothing worth fetching.
  const pickContactUrl = (advLinks: LinkRow[]): string | null => {
    const hub = advLinks.find(l => AGGREGATOR_HOSTS.has(hostOf(l.resolved_url ?? l.url)))
    if (hub) return hub.resolved_url ?? hub.url
    const own = advLinks.find(l => {
      const dest = l.resolved_url ?? l.url
      const h = hostOf(dest)
      if (h === '' || /(^|\.)(facebook|fb|instagram|fbcdn|whatsapp|messenger)\./.test(h)) return false
      if (isFunnelLink(l)) return false // promoted operator, not the affiliate's own site
      if (isAffiliateCasinoLink(dest, denylist)) return false // known casino operator
      return true
    })
    return own ? own.resolved_url ?? own.url : null
  }

  type Scored = {
    a: AdvertiserRow
    result: ReturnType<typeof scoreFbAdvertiser>
    advLinks: LinkRow[]
    contacts: ReturnType<typeof extractContacts>
    fetchUrl: string | null
  }
  const prelim: Scored[] = rows.map(a => {
    const advLinks = linksByAdvertiser.get(a.id) ?? []
    const scoreLinks: FbScoreLink[] = advLinks.map(l => ({ url: l.url, resolved_url: l.resolved_url }))
    const result = scoreFbAdvertiser(
      { page_name: a.page_name, page_category: a.page_category, ad_text_sample: a.ad_text_sample },
      scoreLinks,
      denylist,
    )

    // Contacts from the sampled ad copy + transparency blob + captured link
    // URLs (resolved first so a redirector that expanded to a t.me/discord
    // invite still counts).
    const linkUrls = advLinks.flatMap(l => [l.resolved_url, l.url].filter((u): u is string => !!u))
    if (a.page_website_url) linkUrls.push(a.page_website_url)
    const contacts = extractContacts([a.ad_text_sample ?? '', a.page_transparency ?? ''], linkUrls)

    // Worth a page fetch only when the Page looks affiliate AND we still lack an
    // email — the FB scrape never fetches these pages, so the affiliate's own
    // hub/landing is the only place to mine the email they publish.
    const fetchUrl = result.isLikelyAffiliate && !contacts.email ? pickContactUrl(advLinks) : null
    return { a, result, advLinks, contacts, fetchUrl }
  })

  // Batch-fetch the candidate pages (bounded concurrency + hard cap), then mine
  // each page's HTML for the contacts the ad copy didn't carry.
  const pageUrls = prelim.map(p => p.fetchUrl).filter((u): u is string => !!u)
  let pagesFetched = 0
  if (pageUrls.length > 0) {
    const htmlByUrl = await fetchPagesHtml(pageUrls)
    pagesFetched = htmlByUrl.size
    for (const p of prelim) {
      if (!p.fetchUrl) continue
      const html = htmlByUrl.get(p.fetchUrl)
      if (!html) continue
      // HTML extractor → emails (mailto + obfuscated); text extractor over the
      // same HTML → Telegram/Discord from the hrefs it contains. Fill only the
      // gaps so a contact already mined from the ad copy is never clobbered.
      const fromHtml = extractContactsFromHtml(html, p.fetchUrl)
      const fromLinks = extractContacts([html], [])
      if (!p.contacts.email) p.contacts.email = fromHtml.emails[0] ?? fromLinks.email ?? null
      if (!p.contacts.telegram_url) p.contacts.telegram_url = fromLinks.telegram_url
      if (!p.contacts.discord_url) p.contacts.discord_url = fromLinks.discord_url
    }
  }

  // Persist scores + contacts + new-vs-known verdict.
  let scored = 0
  let likelyAffiliates = 0
  let newCandidates = 0
  let withContacts = 0
  for (const { a, result, advLinks, contacts } of prelim) {
    // New-lead check: a casino link whose affiliate ID/operator isn't on
    // Monday, OR the page_name itself isn't on Monday (only for likely
    // affiliates — Page-level redirector links often carry no in-URL stag).
    const hasNewTag = advLinks.some(l => l.is_known_on_monday === false)
    let nameIsNew = false
    if (result.isLikelyAffiliate) {
      const name = (a.page_name ?? '').trim()
      if (name.length >= 2) {
        const known = await checkMonday(name)
        nameIsNew = !known
      }
    }
    const isNewCandidate = result.isLikelyAffiliate && (hasNewTag || nameIsNew)

    const update: Record<string, unknown> = {
      is_likely_affiliate: result.isLikelyAffiliate,
      niche_score: result.nicheScore,
      is_new_lead_candidate: isNewCandidate,
      is_known_on_monday: result.isLikelyAffiliate ? !nameIsNew : null,
      contact_email: contacts.email,
      telegram_url: contacts.telegram_url,
      discord_url: contacts.discord_url,
    }

    const { error: upErr } = await svc.from('fb_advertisers').update(update).eq('id', a.id)
    if (upErr) continue
    scored++
    if (result.isLikelyAffiliate) likelyAffiliates++
    if (isNewCandidate) newCandidates++
    if (contacts.email || contacts.telegram_url || contacts.discord_url) withContacts++
  }

  await logActivity({
    action: 'enrichment.fb_score',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { scored, likelyAffiliates, newCandidates, affiliateLinks, linksResolved, withContacts, pagesFetched },
  })

  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: `Scored ${scored} advertiser${scored === 1 ? '' : 's'} — ${likelyAffiliates} likely affiliate${likelyAffiliates === 1 ? '' : 's'}, ${newCandidates} new lead candidate${newCandidates === 1 ? '' : 's'}, ${withContacts} with contact${withContacts === 1 ? '' : 's'}${linksResolved > 0 ? `, ${linksResolved} link${linksResolved === 1 ? '' : 's'} resolved` : ''}.`,
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
  const { data: leadRows, error: leadErr } = await svc
    .from('google_lead_gen_table')
    .select('id')
    .eq('scrape_job_id', jobId)
  if (leadErr) return { status: 'error', error: safeError(leadErr, 'Failed to load leads for this job.') }
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
  const { data: leadRows, error: leadErr } = await svc
    .from('google_lead_gen_table')
    .select('id')
    .eq('scrape_job_id', jobId)
  if (leadErr) return { status: 'error', error: safeError(leadErr, 'Failed to load leads for this job.') }
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
    .select('keyword, country_code, pages, priority, with_enrichment, language, search_engine, view_mode, created_by_email, created_by_username, created_by_display, created_by_is_shadow')
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
    search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | null
    view_mode: 'desktop' | 'mobile' | 'both' | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
  }

  // Re-run = one new scrape_queue row → counts against the daily cap
  // just like a fresh enqueue. Admins are exempt inside checkQuota.
  const quota = await checkQuota(1)
  if (!quota.ok) return { status: 'error', error: quota.error }

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
    created_by_is_shadow: j.created_by_is_shadow ?? false,
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
    .select('keyword, country_code, pages, priority, with_enrichment, language, search_engine, view_mode, result_type_filter, result_summary, created_by_email, created_by_username, created_by_display, created_by_is_shadow')
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
    search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | null
    view_mode: 'desktop' | 'mobile' | 'both' | null
    result_type_filter: 'PPC' | 'Organic' | null
    result_summary: Record<string, unknown> | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
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
      created_by_is_shadow: j.created_by_is_shadow ?? false,
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

  // Pull lead ids + screenshot paths in one query; both cleanups reuse it
  // (storage cleanup is best-effort). Previously this ran two separate
  // SELECTs against google_lead_gen_table for the same job.
  const { data: leadRows } = await svc
    .from('google_lead_gen_table')
    .select('id, screenshot_content_link')
    .eq('scrape_job_id', jobId)
  const rows = (leadRows ?? []) as { id: number; screenshot_content_link: string | null }[]
  const leadIds = rows.map(r => r.id)
  const screenshotPaths = rows
    .map(r => r.screenshot_content_link)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (screenshotPaths.length > 0) {
    try {
      await svc.storage.from('lead-screenshots').remove(screenshotPaths)
    } catch {
      /* best-effort */
    }
  }

  // Also clean up s-tag screenshots if any (all leads on the job, not just
  // those that carried a lead screenshot).
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
    if (stagPaths.length > 0) {
      try {
        await svc.storage.from('lead-screenshots').remove(stagPaths)
      } catch {
        /* best-effort */
      }
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
    .select('id, keyword, country_code, pages, priority, with_enrichment, language, search_engine, view_mode, result_type_filter, created_by_email, created_by_username, created_by_display, created_by_is_shadow')
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
    search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | null
    view_mode: 'desktop' | 'mobile' | 'both' | null
    result_type_filter: 'PPC' | 'Organic' | null
    created_by_email: string | null
    created_by_username: string | null
    created_by_display: string | null
    created_by_is_shadow: boolean | null
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
    created_by_is_shadow: r.created_by_is_shadow ?? false,
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

// ============================================================
// Bulk push: for every selected job, push each of its leads to
// Monday's Not Relevant board + mark them locally not-relevant.
//
// Operators asked for this on /scrape so they don't have to open
// each job, multi-select its leads, and push — one right-click on
// the jobs row does the lot. Re-uses the same per-lead push pipeline
// as the /leads context menu so the resulting Monday items get the
// correct status/owner/date/comment columns.
// ============================================================

const PUSH_NR_LEAD_CAP = 500

export async function bulkPushJobLeadsToNotRelevant(
  _prev: BulkScrapeActionState,
  fd: FormData,
): Promise<BulkScrapeActionState> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const jobIds = parseJobIds(fd)
  if (jobIds.length === 0) return { status: 'error', error: 'No jobs selected.' }
  if (jobIds.length > 200) return { status: 'error', error: 'Too many jobs selected (max 200).' }

  const svc = createServiceClient()

  // Resolve the operator's Monday user id once — same fail-loud rule
  // as the per-lead action so we never push un-owned items.
  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('monday_user_id')
    .eq('id', user.id)
    .maybeSingle()
  const pushedByMondayId =
    (profileRow as { monday_user_id: number | null } | null)?.monday_user_id ?? null
  if (pushedByMondayId == null) {
    return {
      status: 'error',
      error:
        'Your account is not linked to a Monday user yet. Ask an admin to set your Monday ID at /admin/users so pushes land under you.',
    }
  }
  const pushedBy = user.email ?? 'unknown@local'

  // Cohort gate — admin bypass, else every job in the list must be in
  // the caller's cohort. Mirrors requireLeadsAccess but on jobs.
  const { data: isAdminRaw } = await svc.rpc('is_admin', { p_user_id: user.id })
  const isAdmin = isAdminRaw === true
  if (!isAdmin) {
    const { data: cohortRows } = await svc
      .from('scrape_queue')
      .select('id, created_by_email, created_by_is_shadow')
      .in('id', jobIds)
    type J = { id: string; created_by_email: string | null; created_by_is_shadow: boolean | null }
    const callerEmail = (user.email ?? '').toLowerCase()
    const callerIsShadowRpc = await svc.rpc('is_shadow_user', { p_user_id: user.id })
    const callerIsShadow = callerIsShadowRpc.data === true
    for (const j of (cohortRows ?? []) as J[]) {
      const ownerEmail = (j.created_by_email ?? '').toLowerCase()
      const ownerIsShadow = j.created_by_is_shadow === true
      if (callerIsShadow) {
        if (ownerEmail !== callerEmail) {
          return { status: 'error', error: 'One or more selected jobs are not yours.' }
        }
      } else if (ownerIsShadow) {
        return { status: 'error', error: 'One or more selected jobs belong to a private account.' }
      }
    }
  }

  // Load every lead from the selected jobs that hasn't already been
  // pushed to the not-relevant board. Skips the already-pushed ones
  // (idempotency would noop them anyway, but skipping avoids 1k
  // unnecessary Monday calls and tightens the count messaging).
  const { data: leadRows, error: leadErr } = await svc
    .from('google_lead_gen_table')
    .select('id, scrape_job_id, monday_pushed_item_id, monday_board')
    .in('scrape_job_id', jobIds)
  if (leadErr) {
    return { status: 'error', error: safeError(leadErr, 'Failed to load leads.') }
  }
  type LR = {
    id: number
    scrape_job_id: string
    monday_pushed_item_id: string | null
    monday_board: string | null
  }
  const allLeads = (leadRows ?? []) as LR[]
  const toPush = allLeads.filter(
    l => !(l.monday_pushed_item_id && l.monday_board === 'not_relevant_leads'),
  )
  const alreadyOnBoard = allLeads.length - toPush.length

  if (toPush.length === 0) {
    return {
      status: 'ok',
      message:
        alreadyOnBoard > 0
          ? `Nothing to push — all ${alreadyOnBoard} lead${alreadyOnBoard === 1 ? ' is' : 's are'} already on the Not Relevant board.`
          : 'No leads to push — the selected jobs have no rows yet.',
    }
  }
  if (toPush.length > PUSH_NR_LEAD_CAP) {
    return {
      status: 'error',
      error: `That selection would push ${toPush.length} leads to Monday — over the ${PUSH_NR_LEAD_CAP} cap. Narrow your selection first.`,
    }
  }

  // Push one at a time — Monday's create_item is rate-limited and a
  // burst would trip the throttle. The /leads bulk path also runs
  // serial; users see the count tick up via the toast on the right.
  const { pushLeadToMondayNotRelevant } = await import('@/lib/monday/push-not-relevant')
  let pushed = 0
  const errors: string[] = []
  for (const l of toPush) {
    const result = await pushLeadToMondayNotRelevant(l.id, {
      pushedBy,
      pushedByMondayId,
    })
    if (result.ok) pushed += 1
    else errors.push(`lead ${l.id}: ${result.error}`)
  }

  await logActivity({
    action: 'scrape.bulk_push_leads_not_relevant',
    entity_type: 'scrape_jobs_bulk',
    details: {
      jobs: jobIds.length,
      leads_considered: allLeads.length,
      leads_pushed: pushed,
      already_on_board: alreadyOnBoard,
      errors: errors.length,
    },
  })

  revalidatePath('/scrape')
  revalidatePath('/leads')

  const summary =
    `Pushed ${pushed}/${toPush.length} lead${toPush.length === 1 ? '' : 's'} ` +
    `from ${jobIds.length} job${jobIds.length === 1 ? '' : 's'}` +
    (alreadyOnBoard > 0 ? ` (skipped ${alreadyOnBoard} already on board)` : '') +
    '.'
  if (errors.length > 0) {
    return {
      status: 'error',
      error: `${summary} Errors: ${errors.slice(0, 3).join(' · ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`,
    }
  }
  return { status: 'ok', message: summary }
}

// ============================================================
// Mark / unmark a scrape job as "reviewed" — a shared (team-wide) flag so
// operators can see at a glance which scrapes have already been eyeballed
// on the /scrape Recent-jobs table. Open to any signed-in user (like the
// Monday duplicate check) — it's an informational flag, not a destructive
// or proxy-spending action, so restricting it to the owner would just block
// testers. Records who last toggled it.
// ============================================================

export async function toggleJobReviewed(
  _prev: JobActionState,
  fd: FormData,
): Promise<JobActionState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const reviewed = String(fd.get('reviewed') ?? '') === 'true'

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const svc = createServiceClient()
  // Resolve a friendly name so the row records WHO reviewed it.
  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('username, display_name')
    .eq('id', user.id)
    .maybeSingle()
  const profile = profileRow as { username: string | null; display_name: string | null } | null
  const reviewerName = profile?.display_name ?? profile?.username ?? user.email ?? user.id

  const { error } = await svc
    .from('scrape_queue')
    .update({
      reviewed_at: reviewed ? new Date().toISOString() : null,
      reviewed_by: reviewed ? reviewerName : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
  if (error) return { status: 'error', error: safeError(error, 'Failed to update reviewed flag.') }

  await logActivity({
    action: reviewed ? 'scrape.mark_reviewed' : 'scrape.unmark_reviewed',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { reviewed_by: reviewerName },
  })

  revalidatePath('/scrape')
  revalidatePath(`/scrape/${jobId}`)
  return {
    status: 'ok',
    message: reviewed ? 'Marked as reviewed.' : 'Marked as not reviewed.',
  }
}

// ============================================================
// Push to Monday — job level. Sends every worth-pushing result of this
// scrape (affiliate-flagged leads for Google/Bing, likely-affiliate
// entities for the social engines) onto the Rooster Leads board in one
// action. Reuses the proven per-lead push and the generic per-entity push.
//
// Gated owner-or-admin (via requireJobAccess) because it creates real
// items on a shared external board — same trust level as the per-lead push
// in the leads drawer.
// ============================================================

export type PushJobState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export async function pushJobToMondayAction(
  _prev: PushJobState,
  fd: FormData,
): Promise<PushJobState> {
  const jobId = jobIdFrom(fd)
  if (!jobId) return { status: 'error', error: 'Missing job id.' }
  const access = await requireJobAccess(jobId)
  if (!access.ok) return { status: 'error', error: access.error }

  const note = String(fd.get('note') ?? '').trim().slice(0, 5000)

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  // Resolve the pushing user's Monday id so items land under their name —
  // same rule as the per-lead push. Block when unlinked rather than
  // silently impersonating a shared default owner.
  const svc = createServiceClient()
  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('username, display_name, monday_user_id')
    .eq('id', user.id)
    .maybeSingle()
  const profile = profileRow as
    | { username: string | null; display_name: string | null; monday_user_id: number | null }
    | null
  const pushedByDisplay = profile?.display_name ?? profile?.username ?? user.email ?? user.id
  const ownerId = profile?.monday_user_id ?? null
  if (ownerId == null) {
    return {
      status: 'error',
      error:
        'Your account is not linked to a Monday user yet. Ask an admin to set your Monday ID at /admin/users so pushes land under you.',
    }
  }

  let result: Awaited<ReturnType<typeof pushJobToMondayLib>>
  try {
    result = await pushJobToMondayLib(jobId, {
      pushedBy: pushedByDisplay,
      ownerId,
      note,
    })
  } catch (err) {
    return { status: 'error', error: safeError(err, 'Failed to push this scrape to Monday.') }
  }
  if (!result.ok) return { status: 'error', error: result.error }

  await logActivity({
    action: 'monday.push_job',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: {
      engine: result.engine,
      kind: result.kind,
      attempted: result.attempted,
      pushed: result.pushed,
      skipped_already_pushed: result.skippedAlreadyPushed,
      failed: result.failed,
      monday_owner_id: ownerId,
    },
  })

  revalidatePath('/scrape')
  revalidatePath(`/scrape/${jobId}`)
  revalidatePath('/leads')

  if (result.attempted === 0) {
    const skipNote =
      result.skippedAlreadyPushed > 0
        ? ` (${result.skippedAlreadyPushed} already on Monday)`
        : ''
    return {
      status: 'ok',
      message: `No new affiliate leads to push for this scrape${skipNote}.`,
    }
  }
  const tail = [
    result.skippedAlreadyPushed > 0 ? `${result.skippedAlreadyPushed} already pushed` : '',
    result.failed > 0 ? `${result.failed} failed` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const errTail =
    result.failed > 0 && result.errors.length > 0 ? ` — ${result.errors.slice(0, 2).join(' · ')}` : ''
  return {
    status: result.failed > 0 ? 'error' : 'ok',
    ...(result.failed > 0
      ? { error: `Pushed ${result.pushed}/${result.attempted} to Monday${tail ? ` (${tail})` : ''}${errTail}` }
      : { message: `Pushed ${result.pushed} lead${result.pushed === 1 ? '' : 's'} to Monday${tail ? ` (${tail})` : ''}.` }),
  } as PushJobState
}
