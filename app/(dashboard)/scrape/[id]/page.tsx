import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { LEADS_COLUMNS } from '@/lib/filters/columns-leads'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import { createServiceClient } from '@/lib/supabase/service'
import { AdvancedFilters } from '../../_components/advanced-filters'
import { Pagination } from '../../monday/_components/pagination'
import { LeadsTable } from '../../leads/_components/leads-table'
import {
  DEFAULT_LEAD_PAGE_SIZE,
  LEAD_PAGE_SIZES,
  queryLeads,
} from '../../leads/_lib/query'
import { AutoRefresh } from '../_components/auto-refresh'
import { CaptchaRecoveryBanner } from '../_components/captcha-recovery-banner'
import { EnrichmentStages } from '../_components/enrichment-stages'
import { fetchStageSummary } from '../_lib/queries'

type SearchParams = Record<string, string | string[] | undefined>

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<SearchParams>
}

type Job = {
  id: string
  keyword: string
  country_code: string
  pages: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'captcha' | 'paused' | 'cancelled'
  attempts: number
  batch_id: number | null
  claimed_by: string | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  result_summary: Record<string, unknown> | null
  search_engine: 'google' | 'bing' | 'youtube' | null
  view_mode: 'desktop' | 'mobile' | 'both' | null
  language: string | null
  created_at: string
}

const STATUS_STYLES: Record<Job['status'], string> = {
  pending: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  running: 'bg-[color:var(--color-accent)]/50 text-[color:var(--color-text-primary)]',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  captcha: 'bg-amber-100 text-amber-800',
  paused: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
}

export const dynamic = 'force-dynamic'

export default async function ScrapeJobPage({ params, searchParams }: Props) {
  const { id } = await params
  const sp = await searchParams

  const svc = createServiceClient()
  const { data: jobRaw, error: jobError } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, pages, status, attempts, batch_id, claimed_by, started_at, completed_at, error_message, result_summary, search_engine, view_mode, language, created_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (jobError) {
    console.error('[scrape/[id]]', jobError)
    throw new Error('Failed to load job.')
  }
  if (!jobRaw) notFound()
  const job = jobRaw as Job

  const page = clampInt(sp.page, 1, 1_000_000, 1)
  const size = clampEnum(sp.size, LEAD_PAGE_SIZES, DEFAULT_LEAD_PAGE_SIZE)
  const sort = typeof sp.sort === 'string' ? sp.sort : 'overall_position'
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'desc'
  const q = typeof sp.q === 'string' ? sp.q : ''
  const countryCode = typeof sp.country_code === 'string' ? sp.country_code : ''
  const resultType = typeof sp.result_type === 'string' ? sp.result_type : ''
  const filters = parseFilters(sp.f)
  const sorts = parseSorts(sp.s)

  const [{ rows, total }, stageSummary] = await Promise.all([
    queryLeads({
      page,
      size,
      sort,
      order,
      q,
      countryCode,
      resultType,
      scrapeJobId: id,
      filters,
      sorts,
    }),
    fetchStageSummary(id),
  ])

  // Country and batch are constant for one job, so drop them from the
  // filter dropdowns; URL is constant so omitting them keeps the picker tidy.
  const columns = LEADS_COLUMNS.filter(
    c => c.key !== 'country_code' && c.key !== 'batch_id',
  )

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/scrape"
          className="inline-flex w-fit items-center gap-1 text-[12px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to Scrape
        </Link>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-[16px] font-semibold text-[color:var(--color-text-primary)]">
              <span className="truncate">{job.keyword}</span>
              <EngineBadge engine={job.search_engine} />
              <ViewModeBadge mode={job.view_mode} />
            </h1>
            <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
              {job.country_code} · {job.pages} page{job.pages === 1 ? '' : 's'}
              {job.language && job.language !== 'en' && <> · lang {job.language}</>}
              {job.batch_id !== null && <> · batch {job.batch_id}</>}
              {' · '}
              <span className="text-[color:var(--color-text-primary)]">
                {total.toLocaleString()}
              </span>
              {' '}row{total === 1 ? '' : 's'} scraped
            </p>
          </div>
          <span
            className={[
              'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
              STATUS_STYLES[job.status],
            ].join(' ')}
          >
            {job.status}
          </span>
        </div>
      </header>

      <JobMeta job={job} />

      {job.status === 'captcha' && (
        <CaptchaRecoveryBanner jobId={job.id} errorMessage={job.error_message} />
      )}

      <EnrichmentStages jobId={job.id} summary={stageSummary} />

      <div className="pt-2">
        <AdvancedFilters columns={columns} />
      </div>

      <LeadsTable rows={rows} jobContext />

      <Pagination page={page} size={size} total={total} pageSizeOptions={LEAD_PAGE_SIZES} />

      <AutoRefresh
        enabled={
          job.status === 'pending' ||
          job.status === 'running' ||
          stageSummary.affiliate.inflight_pending + stageSummary.affiliate.inflight_running > 0 ||
          stageSummary.rooster.inflight_pending + stageSummary.rooster.inflight_running > 0 ||
          stageSummary.contact.inflight_pending + stageSummary.contact.inflight_running > 0 ||
          stageSummary.stag.inflight_pending + stageSummary.stag.inflight_running > 0
        }
      />
    </div>
  )
}

function EngineBadge({ engine }: { engine: 'google' | 'bing' | 'youtube' | null }) {
  const e = engine ?? 'google'
  const styles =
    e === 'bing'
      ? 'bg-cyan-100 text-cyan-800'
      : e === 'youtube'
        ? 'bg-red-100 text-red-800'
        : 'bg-blue-100 text-blue-800'
  const label = e === 'youtube' ? 'YouTube' : e === 'bing' ? 'Bing' : 'Google'
  return (
    <span
      title={`Scraped on ${label}`}
      className={[
        'inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        styles,
      ].join(' ')}
    >
      {label}
    </span>
  )
}

function ViewModeBadge({ mode }: { mode: 'desktop' | 'mobile' | 'both' | null }) {
  const m = mode ?? 'both'
  const style =
    m === 'mobile'
      ? 'border-violet-400 text-violet-700'
      : m === 'both'
        ? 'border-orange-400 text-orange-700'
        : 'border-slate-400 text-slate-600'
  const title =
    m === 'mobile'
      ? 'Mobile pass only — iPhone UA + 375x812 viewport.'
      : m === 'both'
        ? 'Desktop pass then mobile pass — catches mobile-only PPC and mobile-ranked organic.'
        : 'Desktop pass only.'
  return (
    <span
      title={title}
      className={[
        'inline-block rounded-full border bg-transparent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        style,
      ].join(' ')}
    >
      {m}
    </span>
  )
}

function JobMeta({ job }: { job: Job }) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: 'Job ID', value: job.id },
    { label: 'Worker', value: job.claimed_by },
    { label: 'Started', value: formatTs(job.started_at) },
    { label: 'Completed', value: formatTs(job.completed_at) },
    { label: 'Duration', value: formatDuration(job.started_at, job.completed_at) },
    { label: 'Attempts', value: String(job.attempts) },
  ].filter(f => f.value)

  const mobileSkipped = mobilePassSkippedReason(job.result_summary)
  const mobileRequested = job.view_mode === 'mobile' || job.view_mode === 'both'

  return (
    <dl className="grid gap-x-4 gap-y-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 text-[11px] md:grid-cols-[auto_1fr_auto_1fr_auto_1fr]">
      {fields.map(f => (
        <div key={f.label} className="contents">
          <dt className="text-[color:var(--color-text-secondary)]">{f.label}</dt>
          <dd className="truncate text-[color:var(--color-text-primary)]" title={f.value ?? undefined}>
            {f.value}
          </dd>
        </div>
      ))}
      {mobileRequested && mobileSkipped && (
        <div className="col-span-full mt-1 rounded-md bg-amber-50 px-3 py-2 text-amber-800">
          <span className="font-medium">Mobile pass skipped:</span>{' '}
          {mobileSkippedExplanation(mobileSkipped)}
        </div>
      )}
      {job.error_message && job.status !== 'captcha' && (
        <div className="col-span-full mt-1 rounded-md bg-red-50 px-3 py-2 text-red-700">
          <span className="font-medium">Error:</span> {job.error_message}
        </div>
      )}
    </dl>
  )
}

function mobilePassSkippedReason(
  summary: Record<string, unknown> | null,
): string | null {
  if (!summary) return null
  const v = summary['mobile_pass_skipped']
  return typeof v === 'string' && v.length > 0 ? v : null
}

function mobileSkippedExplanation(reason: string): string {
  if (reason === 'viewport_setup_failed') {
    return 'mobile viewport setup failed on the worker (CDP override), so the mobile SERP pass never ran. Per-row View tags will show only "desktop" — and mobile-only jobs will return 0 rows. Needs a worker-side fix (vm/scraper.py _set_mobile_viewport).'
  }
  if (reason === 'parse_failed') {
    return 'mobile pass ran without captcha but the parser found 0 rows on every page — most likely the SERP DOM didn’t match our selectors (mobile Google ships a different result container from desktop). Every row is tagged seen_on="desktop" and no mobile-only / cross-device counts are available. Needs a worker-side fix (vm/scraper.py get_google_results_selenium).'
  }
  if (reason === 'captcha') {
    return 'mobile pass aborted on captcha (silent abort to preserve desktop results). Per-row View tags will show only "desktop" for this job.'
  }
  return reason
}

function formatTs(iso: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null
  const start = new Date(startedAt).getTime()
  const end = new Date(completedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function clampInt(
  raw: string | string[] | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function clampEnum<T extends number>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  return (allowed as readonly number[]).includes(n) ? (n as T) : fallback
}
