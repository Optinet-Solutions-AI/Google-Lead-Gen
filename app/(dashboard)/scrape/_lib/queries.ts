import 'server-only'
import { applyFilters, applySorts } from '@/lib/filters/apply'
import { JOBS_COLUMNS } from '@/lib/filters/columns-jobs'
import type { Filter, Sort } from '@/lib/filters/types'
import { createServiceClient } from '@/lib/supabase/service'
import {
  PIPELINE_STAGES,
  type EnrichmentStatus,
  type ScrapeJob,
  type StageKey,
  type StageTimings,
} from './pipeline'

// Re-export client-safe types for callers that already import from
// queries.ts. The actual definitions live in ./pipeline because that
// module is safe to import from client components — this one isn't.
export {
  PIPELINE_STAGES,
  type EnrichmentStatus,
  type ScrapeJob,
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
  let query = svc
    .from('scrape_queue')
    .select(
      [
        'id, keyword, country_code, pages, priority, status, attempts, captcha_attempts',
        'claimed_by, started_at, completed_at, scheduled_at',
        'with_enrichment, enrichment_status, language, search_engine, view_mode',
        'created_by_email, created_by_username, created_by_display',
        'error_message, result_summary, batch_id, created_at',
      ].join(', '),
      { count: 'exact' },
    )

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
  const jobs = (data ?? []) as unknown as Omit<ScrapeJob, 'enrichment' | 'stage_timings'>[]
  const completedIds = jobs.filter(j => j.status === 'completed').map(j => j.id)
  const [enrichmentByJob, timingsByJob] = await Promise.all([
    fetchEnrichmentStatus(completedIds),
    fetchStageTimings(jobs.filter(j => j.status === 'completed' && j.with_enrichment)),
  ])
  return {
    rows: jobs.map(j => ({
      ...j,
      enrichment: enrichmentByJob.get(j.id) ?? {},
      stage_timings: timingsByJob.get(j.id) ?? null,
    })),
    total: count ?? jobs.length,
  }
}

// ============================================================
// Kanban board data
// ============================================================
//
// Buckets jobs into 6 columns so the /scrape board can render them
// side-by-side without each card having to re-query state:
//
//   pending    — status='pending' AND country is currently locked.
//                Newest-first ordering (user wants to see latest
//                additions at the top).
//   nextInQueue— status='pending' AND country is NOT locked. These
//                are the jobs a worker would claim on its next poll
//                cycle. Capped at NEXT_IN_QUEUE_CAP. Ordered by the
//                same logic claim_scrape_job uses (priority desc,
//                created_at asc) so the top card is genuinely next.
//   running    — status='running'. Capped at RUNNING_CAP. Oldest-
//                running first (those finish soonest).
//   idle       — derived: known scrape + enrichment workers minus
//                workers currently appearing in active_profile_locks
//                or running enrichment rows. One card per idle worker.
//   completed  — status='completed' from the last 24h, newest first.
//   failed     — status in (failed, captcha, cancelled) from the last
//                24h, newest first.

const BOARD_RECENT_HOURS = 24
const NEXT_IN_QUEUE_CAP = 6
const RUNNING_CAP = 6
const ACTIVE_WORKER_LOOKBACK_HOURS = 24

export type BoardWorker = {
  worker_id: string
  kind: 'scrape' | 'enrichment'
  /** When idle: time since last completed job. When running: the job's
   *  country / keyword for at-a-glance context. */
  last_seen_at: string | null
}

/** Compact card shape for a currently-running enrichment job. They live
 *  in a separate column-section from scrape jobs so we don't have to
 *  cram both kinds into a single discriminated union. */
export type BoardEnrichmentJob = {
  id: string
  lead_id: number | null
  country_code: string | null
  url: string | null
  claimed_by: string | null
  started_at: string | null
  process_stages: string[]
}

export type BoardData = {
  pending: ScrapeJob[]
  next_in_queue: ScrapeJob[]
  running: ScrapeJob[]
  /** Enrichment workers currently processing a lead. Rendered as
   *  separate cards in the running column to match the user's
   *  "6 workers" mental model (3 scrape + 3 enrichment). */
  running_enrichment: BoardEnrichmentJob[]
  idle: BoardWorker[]
  completed: ScrapeJob[]
  failed: ScrapeJob[]
  /** Per-column totals (independent of any cap applied to the array
   *  above). Surfaces the "+N more" footer when a column is capped. */
  totals: {
    pending: number
    next_in_queue: number
    running: number
    running_enrichment: number
    idle: number
    completed: number
    failed: number
  }
}

/** Bucket scrape jobs and current enrichment activity into the six
 *  Kanban columns. Applies the same `q` / `filters` / `sorts` the
 *  table view honours so AdvancedFilters above the board narrows
 *  every column simultaneously. */
export async function queryBoardData(opts: {
  q?: string
  filters?: Filter[]
  sorts?: Sort[]
}): Promise<BoardData> {
  const svc = createServiceClient()
  const cutoffIso = new Date(Date.now() - BOARD_RECENT_HOURS * 3600_000).toISOString()
  const workerCutoffIso = new Date(
    Date.now() - ACTIVE_WORKER_LOOKBACK_HOURS * 3600_000,
  ).toISOString()

  // Single broad scrape_queue pull — every non-terminal job + last 24h
  // of terminal ones. We bucket in TS rather than firing 6 queries.
  let q = svc
    .from('scrape_queue')
    .select(
      [
        'id, keyword, country_code, pages, priority, status, attempts, captcha_attempts',
        'claimed_by, started_at, completed_at, scheduled_at',
        'with_enrichment, enrichment_status, language, search_engine, view_mode',
        'created_by_email, created_by_username, created_by_display',
        'error_message, result_summary, batch_id, created_at',
      ].join(', '),
    )
    .or(
      [
        // Non-terminal: always include
        'status.in.(pending,running,needs_human,paused)',
        // Terminal: include only if recent
        `and(status.in.(completed,failed,captcha,cancelled),updated_at.gte.${cutoffIso})`,
      ].join(','),
    )
    .order('created_at', { ascending: false })
    .limit(500)

  if (opts.q && opts.q.trim().length > 0) {
    const safe = opts.q.replace(/[,()*]/g, '').trim()
    if (safe.length > 0) {
      const or = JOBS_SEARCH_COLUMNS.map(c => `${c}.ilike.%${safe}%`).join(',')
      q = q.or(or)
    }
  }
  if (opts.filters && opts.filters.length > 0) {
    q = applyFilters(q, opts.filters, JOBS_COLUMNS)
  }
  if (opts.sorts && opts.sorts.length > 0) {
    q = applySorts(q, opts.sorts, JOBS_COLUMNS)
  }

  const [
    { data: jobsRaw, error: jobsErr },
    { data: locksRaw, error: locksErr },
    { data: enrichRunningRaw, error: enrichErr },
    { data: scrapeWorkerSeenRaw, error: swErr },
    { data: enrichWorkerSeenRaw, error: ewErr },
  ] = await Promise.all([
    q,
    svc
      .from('active_profile_locks')
      .select('country_code, job_id, worker_id, locked_at'),
    svc
      .from('enrichment_fetch_queue')
      .select('id, lead_id, country_code, url, claimed_by, started_at, process_stages, status')
      .eq('status', 'running')
      .order('started_at', { ascending: true })
      .limit(50),
    svc
      .from('scrape_queue')
      .select('claimed_by, updated_at')
      .not('claimed_by', 'is', null)
      .gte('updated_at', workerCutoffIso),
    svc
      .from('enrichment_fetch_queue')
      .select('claimed_by, updated_at')
      .not('claimed_by', 'is', null)
      .gte('updated_at', workerCutoffIso),
  ])
  if (jobsErr) throw jobsErr
  if (locksErr) throw locksErr
  if (enrichErr) throw enrichErr
  if (swErr) throw swErr
  if (ewErr) throw ewErr

  const baseJobs = (jobsRaw ?? []) as unknown as Omit<
    ScrapeJob,
    'enrichment' | 'stage_timings'
  >[]
  const completedIds = baseJobs.filter(j => j.status === 'completed').map(j => j.id)
  const [enrichmentByJob, timingsByJob] = await Promise.all([
    fetchEnrichmentStatus(completedIds),
    fetchStageTimings(baseJobs.filter(j => j.status === 'completed' && j.with_enrichment)),
  ])
  const jobs: ScrapeJob[] = baseJobs.map(j => ({
    ...j,
    enrichment: enrichmentByJob.get(j.id) ?? {},
    stage_timings: timingsByJob.get(j.id) ?? null,
  }))

  const lockedCountries = new Set<string>()
  for (const l of (locksRaw ?? []) as Array<{ country_code: string }>) {
    lockedCountries.add(l.country_code)
  }

  // Bucket the scrape queue. We compute Next vs Pending by whether the
  // country lock is held — claim_scrape_job's logic skips locked
  // countries, so an unlocked-country pending job IS what the next
  // worker poll will pick up.
  const pending: ScrapeJob[] = []
  const nextInQueue: ScrapeJob[] = []
  const running: ScrapeJob[] = []
  const completed: ScrapeJob[] = []
  const failed: ScrapeJob[] = []

  for (const job of jobs) {
    switch (job.status) {
      case 'pending':
      case 'paused':
        if (lockedCountries.has(job.country_code)) pending.push(job)
        else nextInQueue.push(job)
        break
      case 'running':
        running.push(job)
        break
      case 'completed':
        completed.push(job)
        break
      case 'failed':
      case 'captcha':
      case 'cancelled':
        failed.push(job)
        break
      default:
        // 'needs_human' rows are rendered on /admin/interactive
        // (they each have a paired interactive_checkpoint row with
        // the screenshot + Resume button), so we deliberately skip
        // them on the scrape board.
        break
    }
  }

  // Pending: newest first (user's explicit preference — operators want
  // to confirm "did the scrape I just added land?").
  pending.sort((a, b) => b.created_at.localeCompare(a.created_at))
  // Next: prioritise the actual next-claim order (priority desc, FIFO).
  // Matches claim_scrape_job so the top card is genuinely next.
  nextInQueue.sort((a, b) => {
    const pri = (b.priority ?? 0) - (a.priority ?? 0)
    if (pri !== 0) return pri
    return a.created_at.localeCompare(b.created_at)
  })
  // Running: oldest-running first — those finish soonest.
  running.sort((a, b) => {
    const ax = a.started_at ?? a.created_at
    const bx = b.started_at ?? b.created_at
    return ax.localeCompare(bx)
  })
  // Completed / failed: most recent on top.
  const finishedSort = (a: ScrapeJob, b: ScrapeJob) => {
    const ax = a.completed_at ?? a.created_at
    const bx = b.completed_at ?? b.created_at
    return bx.localeCompare(ax)
  }
  completed.sort(finishedSort)
  failed.sort(finishedSort)

  // Idle workers: distinct claimed_by we've seen in the last 24h on
  // either queue, minus whoever is currently running something.
  const seenScrapeWorkers = new Map<string, string | null>()
  for (const r of (scrapeWorkerSeenRaw ?? []) as Array<{
    claimed_by: string | null
    updated_at: string | null
  }>) {
    if (!r.claimed_by) continue
    const prev = seenScrapeWorkers.get(r.claimed_by)
    if (!prev || (r.updated_at && r.updated_at > prev)) {
      seenScrapeWorkers.set(r.claimed_by, r.updated_at)
    }
  }
  const seenEnrichWorkers = new Map<string, string | null>()
  for (const r of (enrichWorkerSeenRaw ?? []) as Array<{
    claimed_by: string | null
    updated_at: string | null
  }>) {
    if (!r.claimed_by) continue
    const prev = seenEnrichWorkers.get(r.claimed_by)
    if (!prev || (r.updated_at && r.updated_at > prev)) {
      seenEnrichWorkers.set(r.claimed_by, r.updated_at)
    }
  }

  const busyScrapeWorkers = new Set<string>()
  for (const j of running) {
    if (j.claimed_by) busyScrapeWorkers.add(j.claimed_by)
  }
  const enrichmentRunning: BoardEnrichmentJob[] = ((enrichRunningRaw ?? []) as Array<{
    id: string
    lead_id: number | null
    country_code: string | null
    url: string | null
    claimed_by: string | null
    started_at: string | null
    process_stages: unknown
  }>).map(r => ({
    id: r.id,
    lead_id: r.lead_id,
    country_code: r.country_code,
    url: r.url,
    claimed_by: r.claimed_by,
    started_at: r.started_at,
    process_stages: Array.isArray(r.process_stages)
      ? (r.process_stages as string[])
      : [],
  }))
  const busyEnrichWorkers = new Set<string>()
  for (const e of enrichmentRunning) {
    if (e.claimed_by) busyEnrichWorkers.add(e.claimed_by)
  }

  const idle: BoardWorker[] = []
  for (const [w, lastSeen] of seenScrapeWorkers) {
    if (!busyScrapeWorkers.has(w)) {
      idle.push({ worker_id: w, kind: 'scrape', last_seen_at: lastSeen })
    }
  }
  for (const [w, lastSeen] of seenEnrichWorkers) {
    if (!busyEnrichWorkers.has(w)) {
      idle.push({ worker_id: w, kind: 'enrichment', last_seen_at: lastSeen })
    }
  }
  idle.sort((a, b) => a.worker_id.localeCompare(b.worker_id))

  return {
    pending,
    next_in_queue: nextInQueue.slice(0, NEXT_IN_QUEUE_CAP),
    running: running.slice(0, RUNNING_CAP),
    running_enrichment: enrichmentRunning.slice(0, RUNNING_CAP),
    idle,
    completed,
    failed,
    totals: {
      pending: pending.length,
      next_in_queue: nextInQueue.length,
      running: running.length,
      running_enrichment: enrichmentRunning.length,
      idle: idle.length,
      completed: completed.length,
      failed: failed.length,
    },
  }
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
    s_tag_id: number | null
  }
  const data = (await selectInChunks(jobIds, chunk =>
    svc
      .from('google_lead_gen_table')
      .select(
        'id, scrape_job_id, is_on_monday, affiliate_checked_at, rooster_checked_at, contact_checked_at, s_tags_checked_at, s_tag_id',
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
    if (row.s_tag_id != null && leadIdsWithStagCheck.has(row.s_tag_id as number)) {
      acc.stag_check = true
    }
    out.set(jobId, acc)
  }
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
