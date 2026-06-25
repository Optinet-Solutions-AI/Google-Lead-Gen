/**
 * Client-safe constants + types for the enrichment pipeline.
 *
 * Lives outside `queries.ts` because that module imports `server-only`,
 * which Next.js refuses to re-export to client components. Anything
 * the jobs-table (client component) needs at runtime should live here.
 */

/** Enrichment pipeline stages we currently know about. The order is
 *  the pipeline order and drives the rendering of badges in the jobs
 *  table. Add new keys here as new stages land. */
export const PIPELINE_STAGES = [
  { key: 'monday_check', label: 'Monday duplicate check', hidden: false },
  { key: 'affiliate', label: 'Affiliate detection', hidden: false },
  { key: 'rooster', label: 'Rooster partner check', hidden: false },
  { key: 'stags', label: 'S-tag extraction', hidden: false },
  // S-tag verification stage backend stays wired up (RPC + the
  // column on s_tags_table); flagged hidden so the badge in the
  // /scrape table doesn't render. Re-flip when the workflow is final.
  { key: 'stag_check', label: 'S-tag duplicate check', hidden: true },
  // Contact extraction runs LAST so the orchestrator only spends the
  // expensive page-scrape pass on leads that the cheaper stages have
  // already classified.
  { key: 'contacts', label: 'Contact extraction', hidden: false },
] as const

/** Visible-in-UI subset — used by the /scrape pipeline badges so we
 *  don't have to re-iterate the order in two places. */
export const VISIBLE_PIPELINE_STAGES = PIPELINE_STAGES.filter(s => !s.hidden)

export type StageKey = (typeof PIPELINE_STAGES)[number]['key']
export type EnrichmentStatus = Partial<Record<StageKey, boolean>>

/** Kick scrapes don't flow through the leads pipeline above — they write
 *  to `kick_streamers`, so the five leads-pipeline badges never light up
 *  for them. The /scrape table renders this Kick-specific 3-dot variant
 *  instead, mirroring the progression in the job detail's "Kick streamer
 *  profiles" panel: discover (scrape) → Enrich → Score & resolve.
 *
 *  Strict/sequential fill: a dot only lights when its stage is fully
 *  complete. `enriched`/`scored` use >= `discovered` so a partial run
 *  (e.g. 20/25 enriched) leaves the dot empty. The Enriched rule matches
 *  the panel's `pending === 0` exactly so column and panel never disagree. */
export const KICK_PIPELINE_STAGES = [
  { key: 'discovered', label: 'Discovered' },
  { key: 'enriched', label: 'Enriched' },
  { key: 'scored', label: 'Scored & resolved' },
] as const

export type KickStageKey = (typeof KICK_PIPELINE_STAGES)[number]['key']

/** Per-Kick-job counts the badge derives its three dots from. Only present
 *  for completed Kick jobs. */
export type KickPipelineStatus = {
  discovered: number
  enriched: number
  scored: number
}

/** The social engines (everyone except google/bing — and except Kick, which
 *  has its own richer 3-dot variant above). These all write to their own
 *  per-engine entity tables (snapchat_creators, youtube_channels, …) and
 *  NEVER to google_lead_gen_table, so the 5-dot leads pipeline above stays
 *  empty for them — which misreads as "not enriched". They get the 2-dot
 *  progression below instead. */
export const SOCIAL_BADGE_ENGINES = [
  'youtube',
  'twitch',
  'x',
  'facebook',
  'tiktok',
  'snapchat',
  'telegram',
] as const

export type SocialBadgeEngine = (typeof SOCIAL_BADGE_ENGINES)[number]

export function isSocialBadgeEngine(
  engine: ScrapeJob['search_engine'],
): engine is SocialBadgeEngine {
  return (SOCIAL_BADGE_ENGINES as readonly string[]).includes(engine ?? '')
}

/** Two-dot progression for the social engines. Discovery is one pass (the
 *  scrape); "Scored & checked" is the operator-triggered Phase-3 step
 *  (⭐ Score & check on the job detail) that flags affiliates, resolves
 *  links, and checks Monday. The Scored dot stays empty until that step
 *  runs — which is exactly what tells an operator the scrape isn't done
 *  yielding leads yet. */
export const SOCIAL_PIPELINE_STAGES = [
  { key: 'discovered', label: 'Discovered' },
  { key: 'scored', label: 'Scored & checked' },
] as const

export type SocialStageKey = (typeof SOCIAL_PIPELINE_STAGES)[number]['key']

/** Per-social-job counts the 2-dot badge derives from. `discovered` = rows
 *  the scrape wrote; `scored` = rows with a niche_score (Phase 3 ran). Only
 *  present for completed social-engine jobs. */
export type SocialPipelineStatus = {
  discovered: number
  scored: number
}

/** Approximate per-stage timing for a single scrape job. All times in ms. */
export type StageTimings = {
  scrape_ms: number | null
  monday_ms: number | null
  affiliate_ms: number | null
  rooster_ms: number | null
  contact_ms: number | null
  stag_ms: number | null
  stag_check_ms: number | null
  /** End-to-end: from scrape `started_at` to the latest stage end. */
  total_ms: number | null
  /** True when at least one enrichment stage still has rows that will
   *  be processed (drives the "still ticking" UI). */
  enrichment_in_progress: boolean
}

/** Row shape exposed to the client jobs-table. Mirrors the columns
 *  selected by `queryJobs`. Keep in sync with that query. */
export type ScrapeJob = {
  id: string
  keyword: string
  country_code: string
  pages: number
  priority: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'captcha' | 'paused' | 'cancelled'
  attempts: number
  captcha_attempts: number
  claimed_by: string | null
  started_at: string | null
  completed_at: string | null
  scheduled_at: string | null
  with_enrichment: boolean
  enrichment_status: string | null
  language: string | null
  search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | 'x' | 'facebook' | 'tiktok' | 'snapchat' | 'telegram' | null
  view_mode: 'desktop' | 'mobile' | 'both' | null
  created_by_email: string | null
  created_by_username: string | null
  created_by_display: string | null
  error_message: string | null
  result_summary: Record<string, unknown> | null
  batch_id: number | null
  created_at: string
  /** Team-wide "an operator has eyeballed this scrape" flag. NULL = not yet
   *  reviewed. `reviewed_by` is the display name of whoever last ticked it. */
  reviewed_at: string | null
  reviewed_by: string | null
  /** Per-stage applied flags. Only present for completed jobs that have rows. */
  enrichment: EnrichmentStatus
  /** Kick-only progression counts. Present for completed Kick jobs; the
   *  jobs-table renders the 3-dot Kick variant from this instead of the
   *  leads-pipeline badges (which never apply to Kick). Null otherwise. */
  kick: KickPipelineStatus | null
  /** Social-engine progression counts (youtube/twitch/x/facebook/tiktok/
   *  snapchat/telegram). Present for completed jobs on those engines; the
   *  jobs-table renders the 2-dot social variant from this. These engines
   *  write to their own entity tables, not google_lead_gen_table, so the
   *  leads-pipeline badges never apply. Null otherwise. */
  social: SocialPipelineStatus | null
  /** Per-stage timing approximation. Null for non-completed jobs or
   *  jobs without enrichment. */
  stage_timings: StageTimings | null
  /** Who cleared a captcha during this scrape, if one was hit:
   *  'auto_2captcha' (the bot) | 'human'. Undefined when no captcha was
   *  hit or it wasn't looked up. Sourced from interactive_checkpoints. */
  captcha_solved_by?: 'auto_2captcha' | 'human' | null
}
