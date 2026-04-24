import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

export type GoLoginProfile = {
  country_code: string
  country_name: string
}

export async function listActiveProfiles(): Promise<GoLoginProfile[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('gologin_profiles')
    .select('country_code, country_name')
    .eq('is_active', true)
    .not('gologin_profile_id', 'is', null)
    .order('country_name', { ascending: true })
  if (error) throw error
  return (data ?? []) as GoLoginProfile[]
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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'captcha'
  attempts: number
  claimed_by: string | null
  started_at: string | null
  completed_at: string | null
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
}

export type StageSummary = {
  monday: StageStatus
  affiliate: StageStatus
  rooster: StageStatus
  contact: StageStatus
  stag: StageStatus
  stagCheck: StageStatus
}

const EMPTY_STATUS = (): StageStatus => ({ lastRunAt: null, total: 0, positive: 0, errored: 0 })

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
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, pages, priority, status, attempts, claimed_by, started_at, completed_at, error_message, result_summary, batch_id, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  const jobs = (data ?? []) as Omit<ScrapeJob, 'enrichment'>[]

  const completedIds = jobs.filter(j => j.status === 'completed').map(j => j.id)
  const enrichmentByJob = await fetchEnrichmentStatus(completedIds)

  return jobs.map(j => ({ ...j, enrichment: enrichmentByJob.get(j.id) ?? {} }))
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
