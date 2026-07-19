import 'server-only'
import { applyFilters, applySorts } from '@/lib/filters/apply'
import { JOBS_COLUMNS } from '@/lib/filters/columns-jobs'
import { FLEET_TOTAL_SLOTS, readMaxPerCountry } from '@/lib/fleet'
import type { Filter, Sort } from '@/lib/filters/types'
import { applyShadowFilter, getShadowContext } from '@/lib/shadow-filter'
import { createServiceClient } from '@/lib/supabase/service'
import {
  PIPELINE_STAGES,
  SOCIAL_BADGE_ENGINES,
  type EnrichmentStatus,
  type KickPipelineStatus,
  type ScrapeJob,
  type SocialBadgeEngine,
  type SocialPipelineStatus,
  type StageKey,
  type StageTimings,
} from './pipeline'
import { ENGINE_CONFIGS } from '@/lib/monday/engine-config'

// Re-export client-safe types for callers that already import from
// queries.ts. The actual definitions live in ./pipeline because that
// module is safe to import from client components — this one isn't.
export {
  PIPELINE_STAGES,
  type EnrichmentStatus,
  type KickPipelineStatus,
  type ScrapeJob,
  type SocialPipelineStatus,
  type StageKey,
  type StageTimings,
}

export type GoLoginProfile = {
  country_code: string
  country_name: string
  requires_google_login: boolean
  is_google_logged_in: boolean
  /** ISO 639-1 codes valid for this country. The enqueue form filters
   *  the language dropdown to this list (plus 'en' as a fallback). */
  languages: string[]
}

export async function listActiveProfiles(): Promise<GoLoginProfile[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('gologin_profiles')
    .select(
      'country_code, country_name, requires_google_login, is_google_logged_in, languages',
    )
    .eq('is_active', true)
    .not('gologin_profile_id', 'is', null)
    .order('country_name', { ascending: true })
  if (error) throw error
  return ((data ?? []) as Array<GoLoginProfile & { languages: string[] | null }>).map(p => ({
    ...p,
    languages: p.languages ?? ['en'],
  }))
}

export type CountryQueueState = {
  country_code: string
  /** Rows in status='pending' AND (scheduled_at IS NULL OR <= now). */
  pending: number
  /** Rows in status='running' — one per active worker on this country. */
  running: number
  /** max_concurrent_per_country. */
  capacity: number
  /** Est. minutes until a new pending job on this country would start,
   *  given current running + queued and the fleet avg duration. Null
   *  when we don't have enough duration data to compute. */
  etaMinutes: number | null
}

export type PendingPosition = {
  /** 1-indexed position within the country queue (lower = sooner). */
  position: number
  /** Estimated minutes until this job starts. Null when no duration data. */
  etaMinutes: number | null
}

export type FleetQueueSnapshot = {
  /** Ready-to-run pending jobs across the whole fleet. */
  totalPending: number
  /** Currently-running jobs across the whole fleet. */
  totalRunning: number
  /** Pending rows with a future scheduled_at — parked, not competing. */
  scheduledLater: number
  /** Fleet slots in use / total (utilization %). */
  slotsInUse: number
  totalSlots: number
  utilizationPct: number
  /** Avg completed-job duration in the last 24h (seconds). */
  avgDurationSec: number | null
  /** Fleet-wide back-of-envelope drain-time estimate for the pending backlog. */
  fleetEtaMinutes: number | null
  perCountry: CountryQueueState[]
  /** Per-pending-job position + ETA lookup, keyed by scrape_queue.id. */
  positionsByJobId: Record<string, PendingPosition>
}

export async function getFleetQueueSnapshot(): Promise<FleetQueueSnapshot> {
  const svc = createServiceClient()
  const nowIso = new Date().toISOString()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [
    { data: pendingRows },
    { data: runningRows },
    { count: scheduledLater },
    { data: recent },
    capacity,
  ] = await Promise.all([
    // Pending & ready-to-run (no future schedule). Ordered by the same
    // (priority desc, created_at asc) worker-claim order so per-country
    // index reflects real pickup sequence.
    svc
      .from('scrape_queue')
      .select('id, country_code, priority, created_at')
      .eq('status', 'pending')
      .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
      .is('parent_scrape_job_id', null)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(5000),
    // Running.
    svc
      .from('scrape_queue')
      .select('country_code')
      .eq('status', 'running')
      .is('parent_scrape_job_id', null)
      .limit(5000),
    // Scheduled-for-later (parked, doesn't add to queue depth right now).
    svc
      .from('scrape_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .gt('scheduled_at', nowIso)
      .is('parent_scrape_job_id', null),
    // Recent completed durations to derive avg (seed the ETA maths).
    svc
      .from('scrape_queue')
      .select('started_at, completed_at')
      .eq('status', 'completed')
      .gte('completed_at', since24h)
      .not('started_at', 'is', null)
      .not('completed_at', 'is', null)
      .limit(1000),
    readMaxPerCountry(),
  ])

  type PendingRow = { id: string; country_code: string; priority: number | null; created_at: string }
  type RunningRow = { country_code: string }
  const pending = (pendingRows as PendingRow[] | null) ?? []
  const running = (runningRows as RunningRow[] | null) ?? []
  const pendingByCountry = new Map<string, number>()
  const perCountryPendingOrder = new Map<string, PendingRow[]>()
  for (const r of pending) {
    pendingByCountry.set(r.country_code, (pendingByCountry.get(r.country_code) ?? 0) + 1)
    if (!perCountryPendingOrder.has(r.country_code)) perCountryPendingOrder.set(r.country_code, [])
    perCountryPendingOrder.get(r.country_code)!.push(r)
  }
  const runningByCountry = new Map<string, number>()
  for (const r of running) runningByCountry.set(r.country_code, (runningByCountry.get(r.country_code) ?? 0) + 1)

  type Recent = { started_at: string | null; completed_at: string | null }
  const durationsSec = ((recent as Recent[] | null) ?? [])
    .map(r => (new Date(r.completed_at!).getTime() - new Date(r.started_at!).getTime()) / 1000)
    .filter(d => d > 0 && d < 60 * 60 * 6)
  const avgDurationSec = durationsSec.length
    ? Math.round(durationsSec.reduce((s, d) => s + d, 0) / durationsSec.length)
    : null

  const totalPending = pending.length
  const totalRunning = running.length
  const slotsInUse = totalRunning
  const utilizationPct = FLEET_TOTAL_SLOTS > 0 ? (slotsInUse / FLEET_TOTAL_SLOTS) * 100 : 0

  // Fleet-wide back-of-envelope: how long to drain the ready backlog if
  // load stays flat and every slot keeps churning at avg duration.
  const freeSlotsNow = Math.max(0, FLEET_TOTAL_SLOTS - slotsInUse)
  const fleetEtaMinutes =
    avgDurationSec !== null && totalPending > 0
      ? Math.max(
          0,
          Math.ceil(Math.max(0, totalPending - freeSlotsNow) / Math.max(1, FLEET_TOTAL_SLOTS)) *
            (avgDurationSec / 60),
        )
      : totalPending === 0
        ? 0
        : null

  const codes = new Set<string>([...pendingByCountry.keys(), ...runningByCountry.keys()])
  const perCountry: CountryQueueState[] = Array.from(codes)
    .map(code => {
      const p = pendingByCountry.get(code) ?? 0
      const r = runningByCountry.get(code) ?? 0
      // Per-country ETA is bounded by max_concurrent_per_country.
      const freeThisCountry = Math.max(0, capacity - r)
      const etaMinutes =
        avgDurationSec !== null && p > 0
          ? Math.max(
              0,
              Math.ceil(Math.max(0, p - freeThisCountry) / Math.max(1, capacity)) *
                (avgDurationSec / 60),
            )
          : p === 0
            ? 0
            : null
      return {
        country_code: code,
        pending: p,
        running: r,
        capacity,
        etaMinutes,
      }
    })
    .sort((a, b) => b.pending + b.running - (a.pending + a.running))

  // Per-job position + ETA lookup. Position is 1-indexed within the
  // country queue and reflects (priority desc, created_at asc) —
  // exactly what claim_scrape_job uses to pick the next job.
  const positionsByJobId: Record<string, PendingPosition> = {}
  for (const [code, list] of perCountryPendingOrder.entries()) {
    const runningHere = runningByCountry.get(code) ?? 0
    const freeSlotsHere = Math.max(0, capacity - runningHere)
    list.forEach((row, i) => {
      const position = i + 1 // 1-indexed
      // Jobs 1..freeSlotsHere can start immediately; the rest wait in
      // batches of `capacity` per average duration.
      const etaMinutes =
        avgDurationSec === null
          ? null
          : position <= freeSlotsHere
            ? 0
            : Math.ceil((position - freeSlotsHere) / Math.max(1, capacity)) *
              (avgDurationSec / 60)
      positionsByJobId[row.id] = { position, etaMinutes }
    })
  }

  return {
    totalPending,
    totalRunning,
    scheduledLater: scheduledLater ?? 0,
    slotsInUse,
    totalSlots: FLEET_TOTAL_SLOTS,
    utilizationPct,
    avgDurationSec,
    fleetEtaMinutes,
    perCountry,
    positionsByJobId,
  }
}

export type StageStatus = {
  lastRunAt: string | null
  total: number
  /** The primary "positive" count for the stage — interpretation varies:
   *  Monday/stagCheck = matched; Affiliate/Rooster/Contact/Stag = positive flag count. */
  positive: number
  /** Fetch-errored (only tracked for affiliate detection via confidence=ERROR). */
  errored: number
  /** In-flight queue counts (per stage) — drives the loading state on
   *  the play button so users don't spam-click while jobs are in flight. */
  inflight_pending: number
  inflight_running: number
}

export type StageSummary = {
  monday: StageStatus
  affiliate: StageStatus
  rooster: StageStatus
  contact: StageStatus
  stag: StageStatus
  stagCheck: StageStatus
}

const EMPTY_STATUS = (): StageStatus => ({
  lastRunAt: null,
  total: 0,
  positive: 0,
  errored: 0,
  inflight_pending: 0,
  inflight_running: 0,
})

export async function fetchStageSummary(jobId: string): Promise<StageSummary> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select(
      [
        'id',
        'monday_checked_at, is_on_monday',
        'affiliate_checked_at, is_affiliate, affiliate_confidence',
        'rooster_checked_at, is_rooster_partner',
        'contact_checked_at, has_contact_details',
        's_tags_checked_at, has_s_tags',
        'stag_check_checked_at',
      ].join(', '),
    )
    .eq('scrape_job_id', jobId)
  if (error) throw error

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const s: StageSummary = {
    monday: EMPTY_STATUS(),
    affiliate: EMPTY_STATUS(),
    rooster: EMPTY_STATUS(),
    contact: EMPTY_STATUS(),
    stag: EMPTY_STATUS(),
    stagCheck: EMPTY_STATUS(),
  }
  // Scope the tag scan to this job's leads — otherwise this fetches
  // every s_tags_table row in the DB and counts matches that belong
  // to other jobs against the current job's summary.
  const summaryLeadIds = rows
    .map(r => r.id as number | undefined)
    .filter((id): id is number => typeof id === 'number')
  const tagMatchedByLead = new Map<number, boolean>()
  if (summaryLeadIds.length > 0) {
    const { data: tagData, error: tagErr } = await svc
      .from('s_tags_table')
      .select('lead_id, is_existing_on_monday')
      .not('is_existing_on_monday', 'is', null)
      .in('lead_id', summaryLeadIds)
    if (tagErr) throw tagErr
    for (const t of tagData ?? []) {
      const leadId = t.lead_id as number
      if (t.is_existing_on_monday === true) tagMatchedByLead.set(leadId, true)
      else if (!tagMatchedByLead.has(leadId)) tagMatchedByLead.set(leadId, false)
    }
  }

  // ----- in-flight enrichment-fetch-queue counts -----
  // (pending or running enrichment jobs against any lead in this scrape)
  const leadIds = rows
    .map(r => r.id as number | undefined)
    .filter((id): id is number => typeof id === 'number')
  if (leadIds.length > 0) {
    const { data: queueRows, error: qErr } = await svc
      .from('enrichment_fetch_queue')
      .select('process_stages, status')
      .in('status', ['pending', 'running'])
      .in('lead_id', leadIds)
    if (!qErr) {
      const map: Record<string, keyof StageSummary> = {
        affiliate: 'affiliate',
        rooster: 'rooster',
        contact: 'contact',
        stag: 'stag',
      }
      for (const q of queueRows ?? []) {
        const st = (q as { status: string }).status
        const stages = (q as { process_stages: unknown }).process_stages
        if (!Array.isArray(stages)) continue
        for (const stage of stages) {
          if (typeof stage !== 'string') continue
          const key = map[stage]
          if (!key) continue
          if (st === 'pending') s[key].inflight_pending += 1
          else if (st === 'running') s[key].inflight_running += 1
        }
      }
    }
  }

  for (const row of rows) {
    bump(s.monday, row.monday_checked_at as string | null, row.is_on_monday === true, false)
    bump(
      s.affiliate,
      row.affiliate_checked_at as string | null,
      row.is_affiliate === true,
      row.affiliate_confidence === 'ERROR',
    )
    bump(s.rooster, row.rooster_checked_at as string | null, row.is_rooster_partner === true, false)
    bump(s.contact, row.contact_checked_at as string | null, row.has_contact_details === true, false)
    bump(s.stag, row.s_tags_checked_at as string | null, row.has_s_tags === true, false)

    // s-tag dup check: stamp is on parent lead row, match status is per tag
    const leadId = row.id as number | undefined
    const tagCheckTs = row.stag_check_checked_at as string | null
    const tagMatched = leadId != null && tagMatchedByLead.get(leadId) === true
    bump(s.stagCheck, tagCheckTs, tagMatched, false)
  }
  return s
}

function bump(target: StageStatus, ts: string | null, positive: boolean, errored: boolean) {
  if (!ts) return
  target.total += 1
  if (positive) target.positive += 1
  if (errored) target.errored += 1
  // Compare as parsed instants — string `>` mishandles equivalent
  // representations like `+00:00` vs `Z` (lexicographic `+` < `Z`).
  const tsMs = Date.parse(ts)
  if (!Number.isFinite(tsMs)) return
  const curMs = target.lastRunAt ? Date.parse(target.lastRunAt) : NaN
  if (!Number.isFinite(curMs) || tsMs > curMs) target.lastRunAt = ts
}

/** Kick Phase-2 panel summary for one Kick scrape job: how many streamers
 *  Phase 1 discovered, how many have had their kick.com/{slug} about page
 *  scraped (Phase 2), how many failed, and whether a Phase-2 enrichment
 *  job is currently queued/running for this parent. Drives the ▶ button's
 *  enabled/loading state. Counts only — cheap head requests. */
export type KickStreamerSummary = {
  discovered: number
  enriched: number
  failed: number
  pending: number
  /** Streamers that have a niche_score (Phase 3 scoring has run on them). */
  scored: number
  /** Streamers flagged is_likely_affiliate=true. */
  likelyAffiliates: number
  inflight: boolean
  inflightStatus: 'pending' | 'running' | null
}

export async function fetchKickStreamerSummary(jobId: string): Promise<KickStreamerSummary> {
  const svc = createServiceClient()
  const [discoveredRes, enrichedRes, failedRes, scoredRes, affiliateRes, inflightRes] =
    await Promise.all([
      svc.from('kick_streamers').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
      svc
        .from('kick_streamers')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('about_scraped_at', 'is', null),
      svc
        .from('kick_streamers')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('about_fetch_failed', true),
      svc
        .from('kick_streamers')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('niche_score', 'is', null),
      svc
        .from('kick_streamers')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_likely_affiliate', true),
      svc
        .from('scrape_queue')
        .select('status')
        .eq('parent_scrape_job_id', jobId)
        .in('status', ['pending', 'running']),
    ])

  const discovered = discoveredRes.count ?? 0
  const enriched = enrichedRes.count ?? 0
  const failed = failedRes.count ?? 0
  const inflightRows = (inflightRes.data ?? []) as Array<{ status: string }>
  const inflight = inflightRows.length > 0
  const running = inflightRows.some(r => r.status === 'running')
  return {
    discovered,
    enriched,
    failed,
    // Failed streamers are excluded from the enrichment work-list (they've
    // exhausted their fresh-session retries), so they're not pending — else
    // 'pending' could never settle to 0 while any channel is unreachable.
    pending: Math.max(0, discovered - enriched - failed),
    scored: scoredRes.count ?? 0,
    likelyAffiliates: affiliateRes.count ?? 0,
    inflight,
    inflightStatus: inflight ? (running ? 'running' : 'pending') : null,
  }
}

export type KickLinkRow = {
  url: string
  resolved_url: string | null
  source: 'channel_description' | 'stream_title' | 'promo_card' | 'pinned_chat'
  promo_brand: string | null
  is_known_on_monday: boolean | null
}

export type KickStreamerRow = {
  id: string
  slug: string
  channel_url: string
  follower_count: number | null
  is_live: boolean | null
  category_name: string | null
  stream_language: string | null
  instagram_handle: string | null
  twitter_handle: string | null
  facebook_handle: string | null
  youtube_handle: string | null
  tiktok_handle: string | null
  contact_email: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  /** True when the streamer (via its channel slug or any of its casino
   *  links' S-tags / brands) is already known on a Monday board. Null
   *  before scoring runs. */
  is_known_on_monday: boolean | null
  is_new_lead_candidate: boolean | null
  about_scraped_at: string | null
  links: KickLinkRow[]
}

/** Per-streamer rows for the Kick results table, affiliates-first then
 *  niche_score desc then live viewers — with each streamer's promo/pinned
 *  links attached. */
export async function fetchKickStreamerRows(jobId: string): Promise<KickStreamerRow[]> {
  const svc = createServiceClient()
  const { data: streamers, error } = await svc
    .from('kick_streamers')
    .select(
      'id, slug, channel_url, follower_count, is_live, category_name, stream_language, stream_viewer_count, ' +
        'instagram_handle, twitter_handle, facebook_handle, youtube_handle, tiktok_handle, ' +
        'contact_email, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_known_on_monday, is_new_lead_candidate, about_scraped_at',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  type RawRow = Omit<KickStreamerRow, 'links'> & { stream_viewer_count: number | null }
  const rows = (streamers ?? []) as unknown as RawRow[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('kick_links')
    .select('kick_streamer_id, url, resolved_url, source, promo_brand, is_known_on_monday')
    .in('kick_streamer_id', rows.map(r => r.id))
  const linksByStreamer = new Map<string, KickLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<KickLinkRow & { kick_streamer_id: string }>) {
    const arr = linksByStreamer.get(l.kick_streamer_id) ?? []
    arr.push({
      url: l.url,
      resolved_url: l.resolved_url,
      source: l.source,
      promo_brand: l.promo_brand,
      is_known_on_monday: l.is_known_on_monday,
    })
    linksByStreamer.set(l.kick_streamer_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      // affiliates first, then niche_score desc, then live viewers desc
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (b.stream_viewer_count ?? 0) - (a.stream_viewer_count ?? 0)
    })
    .map(r => ({ ...r, links: linksByStreamer.get(r.id) ?? [] }))
}

// ============================================================
// YouTube channels (Phase 1 discovery + Phase 2/3 enrichment) — mirrors the
// Kick streamer summary/rows helpers above.
// ============================================================

export type YoutubeChannelSummary = {
  discovered: number
  /** Channels whose About tab has been scraped (Phase 2 ran). */
  enriched: number
  /** Channels where the email reveal was reCAPTCHA-gated and unsolved. */
  captchaBlocked: number
  pending: number
  /** Channels with a niche_score (Phase 3 scoring has run). */
  scored: number
  likelyAffiliates: number
  /** Likely affiliates carrying ≥1 S-tag not already on Monday. */
  newCandidates: number
  /** Scored channels with no casino funnel link — slot-gameplay vloggers /
   *  land-based casino / news. Hidden from the default results view. */
  notRelevant: number
  inflight: boolean
  inflightStatus: 'pending' | 'running' | null
}

export async function fetchYoutubeChannelSummary(jobId: string): Promise<YoutubeChannelSummary> {
  const svc = createServiceClient()
  const [discoveredRes, enrichedRes, captchaRes, scoredRes, affiliateRes, newRes, notRelevantRes, inflightRes] =
    await Promise.all([
      svc.from('youtube_channels').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
      svc
        .from('youtube_channels')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('about_tab_scraped_at', 'is', null),
      svc
        .from('youtube_channels')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('about_tab_captcha_blocked', true),
      svc
        .from('youtube_channels')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('niche_score', 'is', null),
      // Affiliate / new-lead counts exclude the no-funnel non-affiliates the
      // relevance gate flagged — keeps the headline numbers consistent with the
      // default (relevant-only) results view.
      svc
        .from('youtube_channels')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_likely_affiliate', true)
        .not('is_not_relevant', 'is', true),
      svc
        .from('youtube_channels')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_new_lead_candidate', true)
        .not('is_not_relevant', 'is', true),
      svc
        .from('youtube_channels')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_not_relevant', true),
      svc
        .from('scrape_queue')
        .select('status')
        .eq('parent_scrape_job_id', jobId)
        .in('status', ['pending', 'running']),
    ])

  const discovered = discoveredRes.count ?? 0
  const enriched = enrichedRes.count ?? 0
  const inflightRows = (inflightRes.data ?? []) as Array<{ status: string }>
  const inflight = inflightRows.length > 0
  const running = inflightRows.some(r => r.status === 'running')
  return {
    discovered,
    enriched,
    captchaBlocked: captchaRes.count ?? 0,
    pending: Math.max(0, discovered - enriched),
    scored: scoredRes.count ?? 0,
    likelyAffiliates: affiliateRes.count ?? 0,
    newCandidates: newRes.count ?? 0,
    notRelevant: notRelevantRes.count ?? 0,
    inflight,
    inflightStatus: inflight ? (running ? 'running' : 'pending') : null,
  }
}

export type YoutubeChannelLinkRow = {
  brand: string | null
  s_tag: string | null
  resolved_url: string | null
  is_known_on_monday: boolean | null
}

export type YoutubeChannelRow = {
  id: string
  channel_url: string
  channel_name: string | null
  channel_handle: string | null
  subscriber_count: number | null
  email: string | null
  website_url: string | null
  twitter_url: string | null
  instagram_url: string | null
  tiktok_url: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  /** True when the channel's affiliate IDs / brands / links match an
   *  existing Monday item. Null before scoring runs. */
  is_known_on_monday: boolean | null
  is_new_lead_candidate: boolean | null
  /** Phase 3 relevance gate: no casino funnel link → hidden from default view. */
  is_not_relevant: boolean | null
  last_video_at: string | null
  /** Relative "uploaded 3mo ago" label from last_video_at, computed server-side
   *  (Date.now is impure in a component render). */
  last_video_label: string | null
  /** last_video_at older than 90 days — surfaced as a soft warning colour. */
  last_video_stale: boolean
  about_tab_scraped_at: string | null
  about_tab_captcha_blocked: boolean | null
  links: YoutubeChannelLinkRow[]
}

/** Per-channel rows for the YouTube results table: new candidates first,
 *  then affiliates, then niche_score desc, then subscribers — with each
 *  channel's extracted affiliate S-tag links attached. */
export async function fetchYoutubeChannelRows(jobId: string): Promise<YoutubeChannelRow[]> {
  const svc = createServiceClient()
  const { data: channels, error } = await svc
    .from('youtube_channels')
    .select(
      'id, channel_url, channel_name, channel_handle, subscriber_count, email, website_url, ' +
        'twitter_url, instagram_url, tiktok_url, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_known_on_monday, is_new_lead_candidate, is_not_relevant, last_video_at, ' +
        'about_tab_scraped_at, about_tab_captcha_blocked',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  const rows = (channels ?? []) as unknown as Omit<
    YoutubeChannelRow,
    'links' | 'last_video_label' | 'last_video_stale'
  >[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('youtube_channel_links')
    .select('youtube_channel_id, brand, s_tag, resolved_url, is_known_on_monday')
    .in('youtube_channel_id', rows.map(r => r.id))
  const linksByChannel = new Map<string, YoutubeChannelLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<YoutubeChannelLinkRow & { youtube_channel_id: string }>) {
    const arr = linksByChannel.get(l.youtube_channel_id) ?? []
    arr.push({ brand: l.brand, s_tag: l.s_tag, resolved_url: l.resolved_url, is_known_on_monday: l.is_known_on_monday })
    linksByChannel.set(l.youtube_channel_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      const nw = Number(b.is_new_lead_candidate ?? false) - Number(a.is_new_lead_candidate ?? false)
      if (nw !== 0) return nw
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (b.subscriber_count ?? 0) - (a.subscriber_count ?? 0)
    })
    .map(r => {
      const { label, stale } = relativeActivity(r.last_video_at, 'uploaded')
      return { ...r, last_video_label: label, last_video_stale: stale, links: linksByChannel.get(r.id) ?? [] }
    })
}

// ============================================================
// X (x.com) creators (Phase 1 discovery + Phase 2/3 enrichment) — mirrors the
// Kick streamer + YouTube channel summary/rows helpers above.
// ============================================================

export type XCreatorSummary = {
  discovered: number
  /** Creators whose profile page has been scraped (Phase 2 ran). */
  enriched: number
  /** Creators whose profile scrape failed permanently (suspended / gone). */
  failed: number
  pending: number
  /** Creators with a niche_score (Phase 3 scoring has run). */
  scored: number
  likelyAffiliates: number
  /** Likely affiliates with an unknown S-tag/operator or @handle not on Monday. */
  newCandidates: number
  inflight: boolean
  inflightStatus: 'pending' | 'running' | null
}

export async function fetchXCreatorSummary(jobId: string): Promise<XCreatorSummary> {
  const svc = createServiceClient()
  const [discoveredRes, enrichedRes, failedRes, scoredRes, affiliateRes, newRes, inflightRes] =
    await Promise.all([
      svc.from('x_creators').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
      svc
        .from('x_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('about_scraped_at', 'is', null),
      svc
        .from('x_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('about_fetch_failed', true),
      svc
        .from('x_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('niche_score', 'is', null),
      svc
        .from('x_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_likely_affiliate', true),
      svc
        .from('x_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_new_lead_candidate', true),
      svc
        .from('scrape_queue')
        .select('status')
        .eq('parent_scrape_job_id', jobId)
        .in('status', ['pending', 'running']),
    ])

  const discovered = discoveredRes.count ?? 0
  const enriched = enrichedRes.count ?? 0
  const failed = failedRes.count ?? 0
  const inflightRows = (inflightRes.data ?? []) as Array<{ status: string }>
  const inflight = inflightRows.length > 0
  const running = inflightRows.some(r => r.status === 'running')
  return {
    discovered,
    enriched,
    failed,
    // Permanently-failed creators are excluded from the enrichment work-list,
    // so they're not pending — else 'pending' could never settle to 0 while
    // any discovered account is suspended/gone.
    pending: Math.max(0, discovered - enriched - failed),
    scored: scoredRes.count ?? 0,
    likelyAffiliates: affiliateRes.count ?? 0,
    newCandidates: newRes.count ?? 0,
    inflight,
    inflightStatus: inflight ? (running ? 'running' : 'pending') : null,
  }
}

export type XLinkRow = {
  url: string
  resolved_url: string | null
  source: 'bio' | 'pinned_tweet' | 'website'
  brand: string | null
  is_known_on_monday: boolean | null
}

export type XCreatorRow = {
  id: string
  username: string
  profile_url: string
  display_name: string | null
  followers_count: number | null
  verified: boolean | null
  location: string | null
  website_url: string | null
  instagram_handle: string | null
  youtube_handle: string | null
  tiktok_handle: string | null
  facebook_handle: string | null
  contact_email: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  /** True when the creator's affiliate IDs / brands / links match an
   *  existing Monday item. Null before scoring runs. */
  is_known_on_monday: boolean | null
  is_new_lead_candidate: boolean | null
  about_scraped_at: string | null
  links: XLinkRow[]
}

/** Per-creator rows for the X results table: new candidates first, then
 *  affiliates, then niche_score desc, then followers — with each creator's
 *  bio/pinned/website affiliate links attached. */
export async function fetchXCreatorRows(jobId: string): Promise<XCreatorRow[]> {
  const svc = createServiceClient()
  const { data: creators, error } = await svc
    .from('x_creators')
    .select(
      'id, username, profile_url, display_name, followers_count, verified, location, website_url, ' +
        'instagram_handle, youtube_handle, tiktok_handle, facebook_handle, ' +
        'contact_email, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_known_on_monday, is_new_lead_candidate, about_scraped_at',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  const rows = (creators ?? []) as unknown as Omit<XCreatorRow, 'links'>[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('x_links')
    .select('x_creator_id, url, resolved_url, source, brand, is_known_on_monday')
    .in('x_creator_id', rows.map(r => r.id))
  const linksByCreator = new Map<string, XLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<XLinkRow & { x_creator_id: string }>) {
    const arr = linksByCreator.get(l.x_creator_id) ?? []
    arr.push({ url: l.url, resolved_url: l.resolved_url, source: l.source, brand: l.brand, is_known_on_monday: l.is_known_on_monday })
    linksByCreator.set(l.x_creator_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      const nw = Number(b.is_new_lead_candidate ?? false) - Number(a.is_new_lead_candidate ?? false)
      if (nw !== 0) return nw
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (b.followers_count ?? 0) - (a.followers_count ?? 0)
    })
    .map(r => ({ ...r, links: linksByCreator.get(r.id) ?? [] }))
}

// ============================================================
// TikTok creator queries (mirror the X creator queries above; tiktok_creators
// + tiktok_links instead of x_creators + x_links).
// ============================================================
export type TiktokCreatorSummary = {
  discovered: number
  /** Creators whose profile page has been scraped (Phase 2 ran). */
  enriched: number
  /** Creators whose profile scrape failed permanently (suspended / gone). */
  failed: number
  pending: number
  /** Creators with a niche_score (Phase 3 scoring has run). */
  scored: number
  likelyAffiliates: number
  /** Likely affiliates with an unknown S-tag/operator or @handle not on Monday. */
  newCandidates: number
  /** Enriched creators with no funnel link — name-squatters the Phase 2 gate
   *  flagged not-relevant. Hidden from the default results view. */
  notRelevant: number
  inflight: boolean
  inflightStatus: 'pending' | 'running' | null
}

export async function fetchTiktokCreatorSummary(jobId: string): Promise<TiktokCreatorSummary> {
  const svc = createServiceClient()
  const [discoveredRes, enrichedRes, failedRes, scoredRes, affiliateRes, newRes, notRelevantRes, inflightRes] =
    await Promise.all([
      svc.from('tiktok_creators').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
      svc
        .from('tiktok_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('about_scraped_at', 'is', null),
      svc
        .from('tiktok_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('about_fetch_failed', true),
      svc
        .from('tiktok_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .not('niche_score', 'is', null),
      // Affiliate / new-lead counts exclude the no-funnel name-squatters the
      // Phase 2 gate flagged — keeps the headline numbers consistent with the
      // default (relevant-only) results view.
      svc
        .from('tiktok_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_likely_affiliate', true)
        .not('is_not_relevant', 'is', true),
      svc
        .from('tiktok_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_new_lead_candidate', true)
        .not('is_not_relevant', 'is', true),
      svc
        .from('tiktok_creators')
        .select('id', { count: 'exact', head: true })
        .eq('scrape_queue_id', jobId)
        .eq('is_not_relevant', true),
      svc
        .from('scrape_queue')
        .select('status')
        .eq('parent_scrape_job_id', jobId)
        .in('status', ['pending', 'running']),
    ])

  const discovered = discoveredRes.count ?? 0
  const enriched = enrichedRes.count ?? 0
  const failed = failedRes.count ?? 0
  const inflightRows = (inflightRes.data ?? []) as Array<{ status: string }>
  const inflight = inflightRows.length > 0
  const running = inflightRows.some(r => r.status === 'running')
  return {
    discovered,
    enriched,
    failed,
    // Permanently-failed creators are excluded from the enrichment work-list,
    // so they're not pending — else 'pending' could never settle to 0 while
    // any discovered account is suspended/gone.
    pending: Math.max(0, discovered - enriched - failed),
    scored: scoredRes.count ?? 0,
    likelyAffiliates: affiliateRes.count ?? 0,
    newCandidates: newRes.count ?? 0,
    notRelevant: notRelevantRes.count ?? 0,
    inflight,
    inflightStatus: inflight ? (running ? 'running' : 'pending') : null,
  }
}

export type TiktokLinkRow = {
  url: string
  resolved_url: string | null
  source: 'bio_link' | 'video_caption'
  brand: string | null
  is_known_on_monday: boolean | null
}

export type TiktokCreatorRow = {
  id: string
  username: string
  profile_url: string
  display_name: string | null
  bio: string | null
  bio_link: string | null
  follower_count: number | null
  verified: boolean | null
  contact_email: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  /** True when the creator's bio/caption links resolve to an S-tag on
   *  a Monday board. Null before scoring runs. */
  is_known_on_monday: boolean | null
  is_new_lead_candidate: boolean | null
  /** Phase 2 gate: no funnel link → name-squatter, hidden from default view. */
  is_not_relevant: boolean | null
  about_scraped_at: string | null
  links: TiktokLinkRow[]
}

/** Per-creator rows for the TikTok results table: new candidates first, then
 *  affiliates, then niche_score desc, then followers — with each creator's
 *  bio/caption affiliate links attached. */
export async function fetchTiktokCreatorRows(jobId: string): Promise<TiktokCreatorRow[]> {
  const svc = createServiceClient()
  const { data: creators, error } = await svc
    .from('tiktok_creators')
    .select(
      'id, username, profile_url, display_name, bio, bio_link, follower_count, verified, ' +
        'contact_email, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_known_on_monday, is_new_lead_candidate, is_not_relevant, about_scraped_at',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  const rows = (creators ?? []) as unknown as Omit<TiktokCreatorRow, 'links'>[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('tiktok_links')
    .select('tiktok_creator_id, url, resolved_url, source, brand, is_known_on_monday')
    .in('tiktok_creator_id', rows.map(r => r.id))
  const linksByCreator = new Map<string, TiktokLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<TiktokLinkRow & { tiktok_creator_id: string }>) {
    const arr = linksByCreator.get(l.tiktok_creator_id) ?? []
    arr.push({ url: l.url, resolved_url: l.resolved_url, source: l.source, brand: l.brand, is_known_on_monday: l.is_known_on_monday })
    linksByCreator.set(l.tiktok_creator_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      const nw = Number(b.is_new_lead_candidate ?? false) - Number(a.is_new_lead_candidate ?? false)
      if (nw !== 0) return nw
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (b.follower_count ?? 0) - (a.follower_count ?? 0)
    })
    .map(r => ({ ...r, links: linksByCreator.get(r.id) ?? [] }))
}

// ============================================================
// Facebook Ad Library advertiser queries (mirror the X creator queries above;
// fb_advertisers + fb_links instead of x_creators + x_links).
// ============================================================
export type FbAdvertiserSummary = {
  /** Advertiser Pages discovered (the scrape captured them + their links). */
  discovered: number
  /** Pages with a niche_score (Phase 3 "Score & check" has run). */
  scored: number
  /** Pages not yet scored — drives the Score button state. */
  unscored: number
  likelyAffiliates: number
  /** Likely affiliates with an unknown S-tag/operator or page_name not on Monday. */
  newCandidates: number
}

export async function fetchFbAdvertiserSummary(jobId: string): Promise<FbAdvertiserSummary> {
  const svc = createServiceClient()
  const [discoveredRes, scoredRes, affiliateRes, newRes] = await Promise.all([
    svc.from('fb_advertisers').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
    svc
      .from('fb_advertisers')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .not('niche_score', 'is', null),
    svc
      .from('fb_advertisers')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_likely_affiliate', true),
    svc
      .from('fb_advertisers')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_new_lead_candidate', true),
  ])

  const discovered = discoveredRes.count ?? 0
  const scored = scoredRes.count ?? 0
  return {
    discovered,
    scored,
    unscored: Math.max(0, discovered - scored),
    likelyAffiliates: affiliateRes.count ?? 0,
    newCandidates: newRes.count ?? 0,
  }
}

export type FbLinkRow = {
  url: string
  resolved_url: string | null
  source: 'ad_landing' | 'ad_cta' | 'page_website'
  brand: string | null
  is_known_on_monday: boolean | null
}

export type FbAdvertiserRow = {
  id: string
  page_id: string | null
  page_name: string
  page_url: string
  page_category: string | null
  ad_count: number | null
  total_active_ads: number | null
  page_website_url: string | null
  contact_email: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  /** True when this Page (via name / ID / any of its links' S-tags) is
   *  already known on a Monday board. Null before scoring runs. */
  is_known_on_monday: boolean | null
  is_new_lead_candidate: boolean | null
  about_scraped_at: string | null
  links: FbLinkRow[]
}

/** Per-advertiser rows for the Facebook results table: new candidates first,
 *  then affiliates, then niche_score desc, then active-ad count — with each
 *  Page's ad landing/CTA/website links attached. */
export async function fetchFbAdvertiserRows(jobId: string): Promise<FbAdvertiserRow[]> {
  const svc = createServiceClient()
  const { data: advertisers, error } = await svc
    .from('fb_advertisers')
    .select(
      'id, page_id, page_name, page_url, page_category, ad_count, total_active_ads, page_website_url, ' +
        'contact_email, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_known_on_monday, is_new_lead_candidate, about_scraped_at',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  const rows = (advertisers ?? []) as unknown as Omit<FbAdvertiserRow, 'links'>[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('fb_links')
    .select('fb_advertiser_id, url, resolved_url, source, brand, is_known_on_monday')
    .in('fb_advertiser_id', rows.map(r => r.id))
  const linksByAdvertiser = new Map<string, FbLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<FbLinkRow & { fb_advertiser_id: string }>) {
    const arr = linksByAdvertiser.get(l.fb_advertiser_id) ?? []
    arr.push({ url: l.url, resolved_url: l.resolved_url, source: l.source, brand: l.brand, is_known_on_monday: l.is_known_on_monday })
    linksByAdvertiser.set(l.fb_advertiser_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      const nw = Number(b.is_new_lead_candidate ?? false) - Number(a.is_new_lead_candidate ?? false)
      if (nw !== 0) return nw
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (b.total_active_ads ?? b.ad_count ?? 0) - (a.total_active_ads ?? a.ad_count ?? 0)
    })
    .map(r => ({ ...r, links: linksByAdvertiser.get(r.id) ?? [] }))
}

// ============================================================
// Snapchat creator queries (single-pass like Facebook — discover+enrich in one
// scrape, then score; snapchat_creators + snapchat_links).
// ============================================================
export type SnapchatCreatorSummary = {
  discovered: number
  /** Creators with a niche_score (Phase 3 "Score & check" has run). */
  scored: number
  unscored: number
  likelyAffiliates: number
  /** Likely affiliates with an unknown S-tag/operator or @handle not on Monday. */
  newCandidates: number
  /** Scored creators with no affiliate funnel link — lifestyle / land-based /
   *  slot-gameplay non-affiliates. Hidden from the default results view. */
  notRelevant: number
}

export async function fetchSnapchatCreatorSummary(jobId: string): Promise<SnapchatCreatorSummary> {
  const svc = createServiceClient()
  const [discoveredRes, scoredRes, affiliateRes, newRes, notRelevantRes] = await Promise.all([
    svc.from('snapchat_creators').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
    svc
      .from('snapchat_creators')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .not('niche_score', 'is', null),
    // Affiliate / new-lead counts exclude the no-funnel non-affiliates the
    // relevance gate flagged — keeps the headline numbers consistent with the
    // default (relevant-only) results view.
    svc
      .from('snapchat_creators')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_likely_affiliate', true)
      .not('is_not_relevant', 'is', true),
    svc
      .from('snapchat_creators')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_new_lead_candidate', true)
      .not('is_not_relevant', 'is', true),
    svc
      .from('snapchat_creators')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_not_relevant', true),
  ])

  const discovered = discoveredRes.count ?? 0
  const scored = scoredRes.count ?? 0
  return {
    discovered,
    scored,
    unscored: Math.max(0, discovered - scored),
    likelyAffiliates: affiliateRes.count ?? 0,
    newCandidates: newRes.count ?? 0,
    notRelevant: notRelevantRes.count ?? 0,
  }
}

export type SnapchatLinkRow = {
  url: string
  resolved_url: string | null
  source: 'bio_link'
  brand: string | null
  is_known_on_monday: boolean | null
}

export type SnapchatCreatorRow = {
  id: string
  username: string
  profile_url: string
  display_name: string | null
  bio: string | null
  bio_link: string | null
  subscriber_count: number | null
  is_snap_star: boolean | null
  contact_email: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  /** True when the creator's bio-link resolves to an S-tag on a
   *  Monday board. Null before scoring runs. */
  is_known_on_monday: boolean | null
  is_new_lead_candidate: boolean | null
  /** Phase 3 relevance gate: no affiliate funnel link → hidden from default view. */
  is_not_relevant: boolean | null
  links: SnapchatLinkRow[]
}

/** Per-creator rows for the Snapchat results table: new candidates first, then
 *  affiliates, then niche_score desc, then subscribers — with each creator's
 *  bio link attached. */
export async function fetchSnapchatCreatorRows(jobId: string): Promise<SnapchatCreatorRow[]> {
  const svc = createServiceClient()
  const { data: creators, error } = await svc
    .from('snapchat_creators')
    .select(
      'id, username, profile_url, display_name, bio, bio_link, subscriber_count, is_snap_star, ' +
        'contact_email, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_known_on_monday, is_new_lead_candidate, is_not_relevant',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  const rows = (creators ?? []) as unknown as Omit<SnapchatCreatorRow, 'links'>[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('snapchat_links')
    .select('snapchat_creator_id, url, resolved_url, source, brand, is_known_on_monday')
    .in('snapchat_creator_id', rows.map(r => r.id))
  const linksByCreator = new Map<string, SnapchatLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<SnapchatLinkRow & { snapchat_creator_id: string }>) {
    const arr = linksByCreator.get(l.snapchat_creator_id) ?? []
    arr.push({ url: l.url, resolved_url: l.resolved_url, source: l.source, brand: l.brand, is_known_on_monday: l.is_known_on_monday })
    linksByCreator.set(l.snapchat_creator_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      const nw = Number(b.is_new_lead_candidate ?? false) - Number(a.is_new_lead_candidate ?? false)
      if (nw !== 0) return nw
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (b.subscriber_count ?? 0) - (a.subscriber_count ?? 0)
    })
    .map(r => ({ ...r, links: linksByCreator.get(r.id) ?? [] }))
}

// ============================================================
// Telegram channel queries (single-pass like Snapchat/Facebook — discover+
// enrich in one scrape, then score; telegram_channels + telegram_links).
// ============================================================
export type TelegramChannelSummary = {
  discovered: number
  scored: number
  unscored: number
  likelyAffiliates: number
  newCandidates: number
}

export async function fetchTelegramChannelSummary(jobId: string): Promise<TelegramChannelSummary> {
  const svc = createServiceClient()
  const [discoveredRes, scoredRes, affiliateRes, newRes] = await Promise.all([
    svc.from('telegram_channels').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
    svc
      .from('telegram_channels')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .not('niche_score', 'is', null),
    svc
      .from('telegram_channels')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_likely_affiliate', true),
    svc
      .from('telegram_channels')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_new_lead_candidate', true),
  ])

  const discovered = discoveredRes.count ?? 0
  const scored = scoredRes.count ?? 0
  return {
    discovered,
    scored,
    unscored: Math.max(0, discovered - scored),
    likelyAffiliates: affiliateRes.count ?? 0,
    newCandidates: newRes.count ?? 0,
  }
}

export type TelegramLinkRow = {
  url: string
  resolved_url: string | null
  source: 'post' | 'description'
  brand: string | null
  is_known_on_monday: boolean | null
}

export type TelegramChannelRow = {
  id: string
  username: string
  channel_url: string
  title: string | null
  description: string | null
  subscriber_count: number | null
  contact_email: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  /** True when the channel's posted / description links resolve to
   *  an S-tag on a Monday board. Null before scoring runs. */
  is_known_on_monday: boolean | null
  is_new_lead_candidate: boolean | null
  links: TelegramLinkRow[]
}

/** Per-channel rows for the Telegram results table: new candidates first, then
 *  affiliates, then niche_score desc, then subscribers — with each channel's
 *  posted/description links attached. */
export async function fetchTelegramChannelRows(jobId: string): Promise<TelegramChannelRow[]> {
  const svc = createServiceClient()
  const { data: channels, error } = await svc
    .from('telegram_channels')
    .select(
      'id, username, channel_url, title, description, subscriber_count, ' +
        'contact_email, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_known_on_monday, is_new_lead_candidate',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  const rows = (channels ?? []) as unknown as Omit<TelegramChannelRow, 'links'>[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('telegram_links')
    .select('telegram_channel_id, url, resolved_url, source, brand, is_known_on_monday')
    .in('telegram_channel_id', rows.map(r => r.id))
  const linksByChannel = new Map<string, TelegramLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<TelegramLinkRow & { telegram_channel_id: string }>) {
    const arr = linksByChannel.get(l.telegram_channel_id) ?? []
    arr.push({ url: l.url, resolved_url: l.resolved_url, source: l.source, brand: l.brand, is_known_on_monday: l.is_known_on_monday })
    linksByChannel.set(l.telegram_channel_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      const nw = Number(b.is_new_lead_candidate ?? false) - Number(a.is_new_lead_candidate ?? false)
      if (nw !== 0) return nw
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (b.subscriber_count ?? 0) - (a.subscriber_count ?? 0)
    })
    .map(r => ({ ...r, links: linksByChannel.get(r.id) ?? [] }))
}

// ============================================================
// Twitch streamer queries (single-pass like Snapchat/Telegram — Helix
// discover + VOD/clip/panel enrich in one scrape, then score;
// twitch_streamers + twitch_links).
// ============================================================
export type TwitchStreamerSummary = {
  discovered: number
  scored: number
  unscored: number
  likelyAffiliates: number
  newCandidates: number
}

export async function fetchTwitchStreamerSummary(jobId: string): Promise<TwitchStreamerSummary> {
  const svc = createServiceClient()
  const [discoveredRes, scoredRes, affiliateRes, newRes] = await Promise.all([
    svc.from('twitch_streamers').select('id', { count: 'exact', head: true }).eq('scrape_queue_id', jobId),
    svc
      .from('twitch_streamers')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .not('niche_score', 'is', null),
    svc
      .from('twitch_streamers')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_likely_affiliate', true),
    svc
      .from('twitch_streamers')
      .select('id', { count: 'exact', head: true })
      .eq('scrape_queue_id', jobId)
      .eq('is_new_lead_candidate', true),
  ])

  const discovered = discoveredRes.count ?? 0
  const scored = scoredRes.count ?? 0
  return {
    discovered,
    scored,
    unscored: Math.max(0, discovered - scored),
    likelyAffiliates: affiliateRes.count ?? 0,
    newCandidates: newRes.count ?? 0,
  }
}

export type TwitchLinkRow = {
  url: string
  resolved_url: string | null
  source: 'panel' | 'bio' | 'vod_description' | 'clip_description' | 'stream_title'
  brand: string | null
  is_known_on_monday: boolean | null
}

export type TwitchStreamerRow = {
  id: string
  broadcaster_login: string
  display_name: string | null
  broadcaster_url: string
  profile_image_url: string | null
  broadcaster_language: string | null
  is_live: boolean | null
  game_name: string | null
  last_activity_at: string | null
  /** Relative "active 3mo ago" label derived from last_activity_at, computed
   *  server-side (not during render — Date.now is impure in a component). */
  last_active_label: string | null
  /** last_activity_at older than 90 days — surfaced as a soft warning colour. */
  last_active_stale: boolean
  contact_email: string | null
  telegram_url: string | null
  discord_url: string | null
  is_likely_affiliate: boolean | null
  niche_score: number | null
  is_new_lead_candidate: boolean | null
  is_known_on_monday: boolean | null
  links: TwitchLinkRow[]
}

/** Format an activity timestamp as a coarse relative label (e.g. "active 3mo
 *  ago" / "uploaded 2y ago"). Lives here (a plain server function) rather than
 *  in a table component so Date.now() isn't called during React render. stale
 *  = older than 90 days. */
function relativeActivity(iso: string | null, verb: string): { label: string | null; stale: boolean } {
  if (!iso) return { label: null, stale: false }
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return { label: null, stale: false }
  const days = Math.floor((Date.now() - then) / 86_400_000)
  const label =
    days <= 0
      ? `${verb} today`
      : days < 30
        ? `${verb} ${days}d ago`
        : days < 365
          ? `${verb} ${Math.floor(days / 30)}mo ago`
          : `${verb} ${(days / 365).toFixed(1)}y ago`
  return { label, stale: days >= 90 }
}

/** Per-streamer rows for the Twitch results table: new candidates first, then
 *  affiliates, then niche_score desc, then login — with each streamer's
 *  panel/bio/VOD links attached. (No follower count — unavailable with an app
 *  token, so it's never a sort key.) */
export async function fetchTwitchStreamerRows(jobId: string): Promise<TwitchStreamerRow[]> {
  const svc = createServiceClient()
  const { data: streamers, error } = await svc
    .from('twitch_streamers')
    .select(
      'id, broadcaster_login, display_name, broadcaster_url, profile_image_url, ' +
        'broadcaster_language, is_live, game_name, last_activity_at, ' +
        'contact_email, telegram_url, discord_url, ' +
        'is_likely_affiliate, niche_score, is_new_lead_candidate, is_known_on_monday',
    )
    .eq('scrape_queue_id', jobId)
  if (error) throw error
  const rows = (streamers ?? []) as unknown as Omit<
    TwitchStreamerRow,
    'links' | 'last_active_label' | 'last_active_stale'
  >[]
  if (rows.length === 0) return []

  const { data: links } = await svc
    .from('twitch_links')
    .select('twitch_streamer_id, url, resolved_url, source, brand, is_known_on_monday')
    .in('twitch_streamer_id', rows.map(r => r.id))
  const linksByStreamer = new Map<string, TwitchLinkRow[]>()
  for (const l of (links ?? []) as unknown as Array<TwitchLinkRow & { twitch_streamer_id: string }>) {
    const arr = linksByStreamer.get(l.twitch_streamer_id) ?? []
    arr.push({ url: l.url, resolved_url: l.resolved_url, source: l.source, brand: l.brand, is_known_on_monday: l.is_known_on_monday })
    linksByStreamer.set(l.twitch_streamer_id, arr)
  }

  return rows
    .slice()
    .sort((a, b) => {
      const nw = Number(b.is_new_lead_candidate ?? false) - Number(a.is_new_lead_candidate ?? false)
      if (nw !== 0) return nw
      const aff = Number(b.is_likely_affiliate ?? false) - Number(a.is_likely_affiliate ?? false)
      if (aff !== 0) return aff
      const ns = Number(b.niche_score ?? -1) - Number(a.niche_score ?? -1)
      if (ns !== 0) return ns
      return (a.broadcaster_login ?? '').localeCompare(b.broadcaster_login ?? '')
    })
    .map(r => {
      const { label, stale } = relativeActivity(r.last_activity_at, 'active')
      return { ...r, last_active_label: label, last_active_stale: stale, links: linksByStreamer.get(r.id) ?? [] }
    })
}

export async function listRecentJobs(limit = 30): Promise<ScrapeJob[]> {
  return queryJobs({ limit, page: 1, size: limit }).then(r => r.rows)
}

export type JobsQueryOptions = {
  page: number
  size: number
  /** Hard cap on rows returned. Used for the "recent N" callsite. */
  limit?: number
  /** Free-text search across keyword, country_code, error_message. */
  q?: string
  filters?: Filter[]
  sorts?: Sort[]
  /** When set (lowercase email), restrict results to scrapes whose
   *  created_by_email matches. Powers the "Mine / All" toggle on
   *  /scrape — default "mine" so operators land on their own work. */
  restrictToOwnerEmail?: string
}

export type JobsQueryResult = {
  rows: ScrapeJob[]
  total: number
}

const JOBS_SEARCH_COLUMNS = [
  'keyword',
  'country_code',
  'error_message',
  'created_by_display',
  'created_by_username',
]

/** Soft cap for the "All rows" dropdown option on /scrape. */
const JOBS_ROWS_ALL_CAP = 10_000

/** Max IDs per `.in(col, [...])` chunk. PostgREST sends `.in()` as a URL
 *  parameter, so a single call with hundreds of UUIDs overflows the server's
 *  URL-length limit (typically 4–8 KB) and returns a generic PostgrestError.
 *  Splitting into ~100-id chunks keeps each request comfortably under the cap. */
const IN_CHUNK_SIZE = 100

/** Run a query in chunks of IDs and concat the results. Bails on the first
 *  error so the caller can throw exactly as it would with a single `.in()`.
 *  The Row type stays loose (`unknown[]`) because Supabase's typed-select
 *  parser collapses to `GenericStringError[]` for multi-line column lists —
 *  callers cast at the iteration site, same as before. */
async function selectInChunks<V>(
  ids: V[],
  build: (chunk: V[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<unknown[]> {
  const out: unknown[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_CHUNK_SIZE)
    const { data, error } = await build(chunk)
    if (error) throw error
    if (Array.isArray(data)) out.push(...data)
  }
  return out
}

export async function queryJobs(opts: JobsQueryOptions): Promise<JobsQueryResult> {
  const svc = createServiceClient()
  // Shadow isolation: non-shadow viewers never see shadow rows; shadow
  // viewers only ever see their own.
  const shadowCtx = await getShadowContext()
  let query = svc
    .from('scrape_queue')
    .select(
      [
        'id, keyword, country_code, pages, priority, status, attempts, captcha_attempts',
        'claimed_by, started_at, completed_at, scheduled_at',
        'with_enrichment, enrichment_status, language, search_engine, view_mode',
        'created_by_email, created_by_username, created_by_display',
        'error_message, result_summary, batch_id, created_at',
        'reviewed_at, reviewed_by',
      ].join(', '),
      { count: 'exact' },
    )
  // Hide Kick Phase-2 enrichment jobs — they're operator-triggered children
  // of a discovery job (parent_scrape_job_id set), carry no streamers of
  // their own, and would otherwise clutter the list as "No streamers
  // discovered" rows. The parent discovery job stays in the list.
  query = query.is('parent_scrape_job_id', null)
  query = applyShadowFilter(query, shadowCtx) as typeof query

  // "Mine only" gate — when set, restrict to the caller's own scrapes.
  // Defaults to the Mine view on /scrape so operators land on their
  // own work; flip to All via the toggle in the page header.
  if (opts.restrictToOwnerEmail && opts.restrictToOwnerEmail.length > 0) {
    query = query.eq('created_by_email', opts.restrictToOwnerEmail.toLowerCase())
  }

  // Free-text search across a small set of columns.
  if (opts.q && opts.q.trim().length > 0) {
    const safe = opts.q.replace(/[,()*]/g, '').trim()
    if (safe.length > 0) {
      const or = JOBS_SEARCH_COLUMNS.map(c => `${c}.ilike.%${safe}%`).join(',')
      query = query.or(or)
    }
  }

  // Advanced filters from URL (`?f=`).
  if (opts.filters && opts.filters.length > 0) {
    query = applyFilters(query, opts.filters, JOBS_COLUMNS)
  }

  // Advanced multi-sort, falling back to created_at desc.
  if (opts.sorts && opts.sorts.length > 0) {
    query = applySorts(query, opts.sorts, JOBS_COLUMNS)
  } else {
    query = query.order('created_at', { ascending: false })
  }

  // Pagination: explicit page/size when given, else honour the legacy `limit`.
  // size === 0 is the UI "All" sentinel; we cap at JOBS_ROWS_ALL_CAP so a
  // multi-thousand-job table doesn't lock the browser.
  if (opts.limit && opts.limit > 0) {
    query = query.range(0, opts.limit - 1)
  } else if (opts.size === 0) {
    query = query.range(0, JOBS_ROWS_ALL_CAP - 1)
  } else {
    const from = Math.max(0, (opts.page - 1) * opts.size)
    query = query.range(from, from + opts.size - 1)
  }

  const { data, count, error } = await query
  if (error) throw error
  const jobs = (data ?? []) as unknown as Omit<ScrapeJob, 'enrichment' | 'stage_timings' | 'kick' | 'social'>[]
  const completedIds = jobs.filter(j => j.status === 'completed').map(j => j.id)
  const completedKickIds = jobs
    .filter(j => j.status === 'completed' && j.search_engine === 'kick')
    .map(j => j.id)
  // Social-engine jobs (everyone but google/bing/kick) grouped by engine —
  // each engine reads from its own entity table.
  const completedSocialByEngine = new Map<SocialBadgeEngine, string[]>()
  for (const j of jobs) {
    if (j.status !== 'completed') continue
    const eng = j.search_engine
    if (!eng || !(SOCIAL_BADGE_ENGINES as readonly string[]).includes(eng)) continue
    const key = eng as SocialBadgeEngine
    const arr = completedSocialByEngine.get(key) ?? []
    arr.push(j.id)
    completedSocialByEngine.set(key, arr)
  }
  const [enrichmentByJob, timingsByJob, captchaByJob, kickByJob, socialByJob] = await Promise.all([
    fetchEnrichmentStatus(completedIds),
    fetchStageTimings(jobs.filter(j => j.status === 'completed' && j.with_enrichment)),
    fetchCaptchaSolvedBy(jobs.map(j => j.id)),
    fetchKickProgress(completedKickIds),
    fetchSocialProgress(completedSocialByEngine),
  ])
  return {
    rows: jobs.map(j => ({
      ...j,
      enrichment: enrichmentByJob.get(j.id) ?? {},
      stage_timings: timingsByJob.get(j.id) ?? null,
      captcha_solved_by: captchaByJob.get(j.id) ?? null,
      kick: kickByJob.get(j.id) ?? null,
      social: socialByJob.get(j.id) ?? null,
    })),
    total: count ?? jobs.length,
  }
}

/** Per-job captcha attribution from interactive_checkpoints: did the
 *  bot (2Captcha) or a human clear a captcha during this scrape? Bot
 *  wins display priority if both somehow appear. Absent → no captcha
 *  recorded (or pre-attribution history). One query for the page. */
async function fetchCaptchaSolvedBy(
  jobIds: string[],
): Promise<Map<string, 'auto_2captcha' | 'human'>> {
  const out = new Map<string, 'auto_2captcha' | 'human'>()
  if (jobIds.length === 0) return out
  const svc = createServiceClient()
  const { data } = await svc
    .from('interactive_checkpoints')
    .select('job_id, resolution_method')
    .in('job_id', jobIds)
    .eq('reason', 'captcha')
    .in('resolution_method', ['auto_2captcha', 'human'])
  for (const r of (data ?? []) as Array<{ job_id: string; resolution_method: string }>) {
    if (r.resolution_method === 'auto_2captcha') out.set(r.job_id, 'auto_2captcha')
    else if (!out.get(r.job_id)) out.set(r.job_id, 'human')
  }
  return out
}

/** One query, aggregated in TS — cheap for ~30 jobs × ~10 rows each. */
async function fetchEnrichmentStatus(
  jobIds: string[],
): Promise<Map<string, EnrichmentStatus>> {
  const out = new Map<string, EnrichmentStatus>()
  if (jobIds.length === 0) return out

  const svc = createServiceClient()
  type LeadRow = {
    id: number
    scrape_job_id: string | null
    is_on_monday: boolean | null
    affiliate_checked_at: string | null
    rooster_checked_at: string | null
    contact_checked_at: string | null
    s_tags_checked_at: string | null
  }
  const data = (await selectInChunks(jobIds, chunk =>
    svc
      .from('google_lead_gen_table')
      .select(
        'id, scrape_job_id, is_on_monday, affiliate_checked_at, rooster_checked_at, contact_checked_at, s_tags_checked_at',
      )
      .in('scrape_job_id', chunk),
  )) as unknown as LeadRow[]

  // s_tag_check stage applied if any s_tags_table row for the job has a
  // non-null is_existing_on_monday — fetch that separately, scoped to
  // this job's leads (was previously a full-table scan that picked up
  // matches from unrelated jobs).
  const leadIdsForStag = data
    .map(r => r.id as number | undefined)
    .filter((id): id is number => typeof id === 'number')
  const leadIdsWithStagCheck = new Set<number>()
  if (leadIdsForStag.length > 0) {
    type StagDupRow = { lead_id: number; is_existing_on_monday: boolean | null }
    const stagDup = (await selectInChunks(leadIdsForStag, chunk =>
      svc
        .from('s_tags_table')
        .select('lead_id, is_existing_on_monday')
        .not('is_existing_on_monday', 'is', null)
        .in('lead_id', chunk),
    )) as unknown as StagDupRow[]
    for (const r of stagDup) leadIdsWithStagCheck.add(r.lead_id as number)
  }

  for (const row of data) {
    const jobId = row.scrape_job_id as string | null
    if (!jobId) continue
    const acc = out.get(jobId) ?? {}
    if (row.is_on_monday !== null) acc.monday_check = true
    if (row.affiliate_checked_at !== null) acc.affiliate = true
    if (row.rooster_checked_at !== null) acc.rooster = true
    if (row.contact_checked_at !== null) acc.contacts = true
    if (row.s_tags_checked_at !== null) acc.stags = true
    // Key on the lead's own id — leadIdsWithStagCheck holds s_tags_table.lead_id
    // values (the google_lead_gen_table.id space). row.s_tag_id is an FK to
    // s_tags_table.id (a different sequence), so testing it here only matched on
    // coincidental id collisions.
    if (leadIdsWithStagCheck.has(row.id)) {
      acc.stag_check = true
    }
    out.set(jobId, acc)
  }
  return out
}

/** Per-Kick-job progression counts for the jobs-table badge. Kick scrapes
 *  populate `kick_streamers`, not the leads table, so the leads-pipeline
 *  badges never apply — this drives the 3-dot Kick variant instead.
 *
 *  One chunked query over all the page's Kick jobs (vs. the per-job head
 *  requests in `fetchKickStreamerSummary`, which the detail page uses):
 *  selects the two booleans we fold into discovered/enriched/scored counts.
 *  `enriched` = has `about_scraped_at`; `scored` = has `niche_score`. */
async function fetchKickProgress(
  jobIds: string[],
): Promise<Map<string, KickPipelineStatus>> {
  const out = new Map<string, KickPipelineStatus>()
  if (jobIds.length === 0) return out

  const svc = createServiceClient()
  type Row = {
    scrape_queue_id: string | null
    about_scraped_at: string | null
    niche_score: number | null
  }
  const rows = (await selectInChunks(jobIds, chunk =>
    svc
      .from('kick_streamers')
      .select('scrape_queue_id, about_scraped_at, niche_score')
      .in('scrape_queue_id', chunk),
  )) as unknown as Row[]

  for (const r of rows) {
    const jobId = r.scrape_queue_id
    if (!jobId) continue
    const acc = out.get(jobId) ?? { discovered: 0, enriched: 0, scored: 0 }
    acc.discovered += 1
    if (r.about_scraped_at !== null) acc.enriched += 1
    if (r.niche_score !== null) acc.scored += 1
    out.set(jobId, acc)
  }
  return out
}

/** Per-social-job progression counts for the jobs-table 2-dot badge. The
 *  social engines (youtube/twitch/x/facebook/tiktok/snapchat/telegram) write
 *  to their own entity tables — never google_lead_gen_table — so the leads
 *  pipeline never lights up for them and they'd otherwise read as "not
 *  enriched". This drives Discovered → Scored & checked instead.
 *
 *  `discovered` = rows the scrape wrote; `scored` = rows with a niche_score
 *  (the operator-triggered Phase-3 "Score & check" has run). One chunked
 *  query per engine over that engine's entity table. Table/queue-FK names
 *  come from ENGINE_CONFIGS; every entity table uses scrape_queue_id +
 *  niche_score. A failed engine query degrades to no badge for those jobs
 *  rather than blowing up the whole page. */
async function fetchSocialProgress(
  jobsByEngine: Map<SocialBadgeEngine, string[]>,
): Promise<Map<string, SocialPipelineStatus>> {
  const out = new Map<string, SocialPipelineStatus>()
  if (jobsByEngine.size === 0) return out

  const svc = createServiceClient()
  type Row = { scrape_queue_id: string | null; niche_score: number | null }

  await Promise.all(
    [...jobsByEngine.entries()].map(async ([engine, jobIds]) => {
      if (jobIds.length === 0) return
      const table = ENGINE_CONFIGS[engine].table
      try {
        const rows = (await selectInChunks(jobIds, chunk =>
          svc.from(table).select('scrape_queue_id, niche_score').in('scrape_queue_id', chunk),
        )) as unknown as Row[]
        for (const r of rows) {
          const jobId = r.scrape_queue_id
          if (!jobId) continue
          const acc = out.get(jobId) ?? { discovered: 0, scored: 0 }
          acc.discovered += 1
          if (r.niche_score !== null) acc.scored += 1
          out.set(jobId, acc)
        }
      } catch {
        // Leave these jobs without a badge — the column shows "—" rather
        // than crashing the page if an engine table is unexpectedly absent.
      }
    }),
  )
  return out
}

/** Approximate per-stage durations from min/max of *_checked_at on the
 *  job's leads. The pipeline runs sequentially in practice
 *  (monday → affiliate → rooster|contact|stag → stag_check) so each
 *  stage's duration is `max(checked_at) - prior_stage_end`, with
 *  prior_stage_end falling back to scrape `completed_at` for the first
 *  stage. Approximate but cheap — no schema change required. */
async function fetchStageTimings(
  jobs: Array<{ id: string; started_at: string | null; completed_at: string | null }>,
): Promise<Map<string, StageTimings>> {
  const out = new Map<string, StageTimings>()
  if (jobs.length === 0) return out

  const jobIds = jobs.map(j => j.id)
  const svc = createServiceClient()

  // Pull every lead's stage timestamps + id (for the s_tag_check join below).
  const leadRows = await selectInChunks(jobIds, chunk =>
    svc
      .from('google_lead_gen_table')
      .select(
        [
          'id, scrape_job_id',
          'monday_checked_at, affiliate_checked_at, rooster_checked_at',
          'contact_checked_at, s_tags_checked_at, stag_check_checked_at',
        ].join(', '),
      )
      .in('scrape_job_id', chunk),
  )

  // s_tag_check_checked_at lives on the lead row, but the actual stage
  // operates per s_tags_table row; fall back to per-lead column which is
  // already aggregated by the RPC that runs the stage.
  type LeadRow = {
    id: number
    scrape_job_id: string | null
    monday_checked_at: string | null
    affiliate_checked_at: string | null
    rooster_checked_at: string | null
    contact_checked_at: string | null
    s_tags_checked_at: string | null
    stag_check_checked_at: string | null
  }

  type StageMax = {
    monday: number | null
    affiliate: number | null
    rooster: number | null
    contact: number | null
    stag: number | null
    stag_check: number | null
    /** Total leads in the job — needed to detect whether enrichment is
     *  still in flight (any stage still has rows with null checked_at). */
    total_leads: number
    /** Per-stage applied row counts — for the in-progress check. */
    monday_done: number
    affiliate_done: number
    rooster_done: number
    contact_done: number
    stag_done: number
    stag_check_done: number
  }

  const perJob = new Map<string, StageMax>()
  for (const r of leadRows as unknown as LeadRow[]) {
    if (!r.scrape_job_id) continue
    const acc = perJob.get(r.scrape_job_id) ?? {
      monday: null,
      affiliate: null,
      rooster: null,
      contact: null,
      stag: null,
      stag_check: null,
      total_leads: 0,
      monday_done: 0,
      affiliate_done: 0,
      rooster_done: 0,
      contact_done: 0,
      stag_done: 0,
      stag_check_done: 0,
    }
    acc.total_leads += 1
    const fold = (key: keyof StageMax, ts: string | null, doneKey: keyof StageMax) => {
      if (!ts) return
      const ms = Date.parse(ts)
      if (!Number.isFinite(ms)) return
      const cur = acc[key] as number | null
      if (cur === null || ms > cur) (acc[key] as number | null) = ms
      ;(acc[doneKey] as number) += 1
    }
    fold('monday', r.monday_checked_at, 'monday_done')
    fold('affiliate', r.affiliate_checked_at, 'affiliate_done')
    fold('rooster', r.rooster_checked_at, 'rooster_done')
    fold('contact', r.contact_checked_at, 'contact_done')
    fold('stag', r.s_tags_checked_at, 'stag_done')
    fold('stag_check', r.stag_check_checked_at, 'stag_check_done')
    perJob.set(r.scrape_job_id, acc)
  }

  for (const job of jobs) {
    const startMs = job.started_at ? Date.parse(job.started_at) : NaN
    const completedMs = job.completed_at ? Date.parse(job.completed_at) : NaN
    if (!Number.isFinite(startMs) || !Number.isFinite(completedMs)) {
      out.set(job.id, {
        scrape_ms: null,
        monday_ms: null,
        affiliate_ms: null,
        rooster_ms: null,
        contact_ms: null,
        stag_ms: null,
        stag_check_ms: null,
        total_ms: null,
        enrichment_in_progress: false,
      })
      continue
    }
    const stages = perJob.get(job.id)
    const scrape_ms = Math.max(0, completedMs - startMs)

    // Each stage starts at the prior stage's end time. The chain is:
    //   monday → affiliate → (rooster + stag in parallel) → stag_check
    //                                                    └→ contact (last)
    // So contact starts at MAX(rooster_end, stag_end) — it's gated on
    // both rooster and stag finishing, not just affiliate.
    const mondayEnd = stages?.monday ?? null
    const affiliateEnd = stages?.affiliate ?? null
    const roosterEnd = stages?.rooster ?? null
    const contactEnd = stages?.contact ?? null
    const stagEnd = stages?.stag ?? null
    const stagCheckEnd = stages?.stag_check ?? null

    const monday_ms = mondayEnd !== null ? Math.max(0, mondayEnd - completedMs) : null
    const affiliateStart = mondayEnd ?? completedMs
    const affiliate_ms = affiliateEnd !== null ? Math.max(0, affiliateEnd - affiliateStart) : null
    const allStart = affiliateEnd ?? affiliateStart
    const rooster_ms = roosterEnd !== null ? Math.max(0, roosterEnd - allStart) : null
    const stag_ms = stagEnd !== null ? Math.max(0, stagEnd - allStart) : null
    const stagCheckStart = stagEnd ?? allStart
    const stag_check_ms = stagCheckEnd !== null ? Math.max(0, stagCheckEnd - stagCheckStart) : null
    // Contact starts AFTER rooster + stag finish (new "contact runs last"
    // chain). Falls back to allStart if neither rooster nor stag has
    // landed yet.
    const contactStart = Math.max(roosterEnd ?? allStart, stagEnd ?? allStart)
    const contact_ms = contactEnd !== null ? Math.max(0, contactEnd - contactStart) : null

    const ends = [completedMs, mondayEnd, affiliateEnd, roosterEnd, contactEnd, stagEnd, stagCheckEnd]
      .filter((v): v is number => typeof v === 'number')
    const lastEnd = ends.length > 0 ? Math.max(...ends) : completedMs
    const total_ms = Math.max(0, lastEnd - startMs)

    // In-progress: any stage where some leads have a checked_at and
    // some don't. We can't observe queue state here cheaply, so the
    // partial-completion heuristic works as a "stage still running".
    const total = stages?.total_leads ?? 0
    const partial = (done: number) => done > 0 && done < total
    const enrichment_in_progress =
      total > 0 &&
      (partial(stages?.monday_done ?? 0) ||
        partial(stages?.affiliate_done ?? 0) ||
        partial(stages?.rooster_done ?? 0) ||
        partial(stages?.contact_done ?? 0) ||
        partial(stages?.stag_done ?? 0) ||
        partial(stages?.stag_check_done ?? 0))

    out.set(job.id, {
      scrape_ms,
      monday_ms,
      affiliate_ms,
      rooster_ms,
      contact_ms,
      stag_ms,
      stag_check_ms,
      total_ms,
      enrichment_in_progress,
    })
  }
  return out
}
