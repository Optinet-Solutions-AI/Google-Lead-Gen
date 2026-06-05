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
  search_engine: 'google' | 'bing' | 'youtube' | 'twitch' | 'kick' | 'x' | 'facebook' | 'tiktok' | null
  view_mode: 'desktop' | 'mobile' | 'both' | null
  created_by_email: string | null
  created_by_username: string | null
  created_by_display: string | null
  error_message: string | null
  result_summary: Record<string, unknown> | null
  batch_id: number | null
  created_at: string
  /** Per-stage applied flags. Only present for completed jobs that have rows. */
  enrichment: EnrichmentStatus
  /** Kick-only progression counts. Present for completed Kick jobs; the
   *  jobs-table renders the 3-dot Kick variant from this instead of the
   *  leads-pipeline badges (which never apply to Kick). Null otherwise. */
  kick: KickPipelineStatus | null
  /** Per-stage timing approximation. Null for non-completed jobs or
   *  jobs without enrichment. */
  stage_timings: StageTimings | null
  /** Who cleared a captcha during this scrape, if one was hit:
   *  'auto_2captcha' (the bot) | 'human'. Undefined when no captcha was
   *  hit or it wasn't looked up. Sourced from interactive_checkpoints. */
  captcha_solved_by?: 'auto_2captcha' | 'human' | null
}
