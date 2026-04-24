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
