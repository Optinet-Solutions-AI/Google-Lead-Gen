import 'server-only'
import { applyFilters, applySorts } from '@/lib/filters/apply'
import { JOBS_COLUMNS } from '@/lib/filters/columns-jobs'
import type { Filter, Sort } from '@/lib/filters/types'
import { createServiceClient } from '@/lib/supabase/service'

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

/** Enrichment pipeline stages we currently know about. Add new keys here
 *  as Epic 7 stages land. The order is the pipeline order and drives the
 *  rendering of badges in the jobs table. */
export const PIPELINE_STAGES = [
  { key: 'monday_check', label: 'Monday duplicate check' },
  { key: 'affiliate', label: 'Affiliate detection' },
  { key: 'rooster', label: 'Rooster partner check' },
  { key: 'contacts', label: 'Contact extraction' },
  { key: 'stags', label: 'S-tag extraction' },
  { key: 'stag_check', label: 'S-tag duplicate check' },
  // 7.7 Monday sync — { key: 'monday_sync', label: 'Monday sync' },
] as const

export type StageKey = (typeof PIPELINE_STAGES)[number]['key']
export type EnrichmentStatus = Partial<Record<StageKey, boolean>>

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
  search_engine: 'google' | 'bing' | null
  created_by_email: string | null
  created_by_username: string | null
  created_by_display: string | null
  error_message: string | null
  result_summary: Record<string, unknown> | null
  batch_id: number | null
  created_at: string
  /** Per-stage applied flags. Only present for completed jobs that have rows. */
  enrichment: EnrichmentStatus
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
  // We also need s-tag-check matches from s_tags_table — query it once and
  // aggregate matched counts per job.
  const { data: tagData, error: tagErr } = await svc
    .from('s_tags_table')
    .select('lead_id, is_existing_on_monday')
    .not('is_existing_on_monday', 'is', null)
  if (tagErr) throw tagErr
  const tagMatchedByLead = new Map<number, boolean>()
  for (const t of tagData ?? []) {
    const leadId = t.lead_id as number
    if (t.is_existing_on_monday === true) tagMatchedByLead.set(leadId, true)
    else if (!tagMatchedByLead.has(leadId)) tagMatchedByLead.set(leadId, false)
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
  if (!target.lastRunAt || ts > target.lastRunAt) target.lastRunAt = ts
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

const JOBS_SEARCH_COLUMNS = ['keyword', 'country_code', 'error_message']

export async function queryJobs(opts: JobsQueryOptions): Promise<JobsQueryResult> {
  const svc = createServiceClient()
  let query = svc
    .from('scrape_queue')
    .select(
      [
        'id, keyword, country_code, pages, priority, status, attempts, captcha_attempts',
        'claimed_by, started_at, completed_at, scheduled_at',
        'with_enrichment, enrichment_status, language, search_engine',
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
  if (opts.limit && opts.limit > 0) {
    query = query.range(0, opts.limit - 1)
  } else {
    const from = Math.max(0, (opts.page - 1) * opts.size)
    query = query.range(from, from + opts.size - 1)
  }

  const { data, count, error } = await query
  if (error) throw error
  const jobs = (data ?? []) as unknown as Omit<ScrapeJob, 'enrichment'>[]
  const completedIds = jobs.filter(j => j.status === 'completed').map(j => j.id)
  const enrichmentByJob = await fetchEnrichmentStatus(completedIds)
  return {
    rows: jobs.map(j => ({ ...j, enrichment: enrichmentByJob.get(j.id) ?? {} })),
    total: count ?? jobs.length,
  }
}

/** One query, aggregated in TS — cheap for ~30 jobs × ~10 rows each. */
async function fetchEnrichmentStatus(
  jobIds: string[],
): Promise<Map<string, EnrichmentStatus>> {
  const out = new Map<string, EnrichmentStatus>()
  if (jobIds.length === 0) return out

  const svc = createServiceClient()
  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select(
      'scrape_job_id, is_on_monday, affiliate_checked_at, rooster_checked_at, contact_checked_at, s_tags_checked_at, s_tag_id',
    )
    .in('scrape_job_id', jobIds)
  if (error) throw error

  // s_tag_check stage applied if any s_tags_table row for the job has a
  // non-null is_existing_on_monday — fetch that separately.
  const { data: stagDup, error: stagErr } = await svc
    .from('s_tags_table')
    .select('lead_id, is_existing_on_monday')
    .not('is_existing_on_monday', 'is', null)
  if (stagErr) throw stagErr
  const leadIdsWithStagCheck = new Set<number>(
    (stagDup ?? []).map(r => r.lead_id as number),
  )

  for (const row of data ?? []) {
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
