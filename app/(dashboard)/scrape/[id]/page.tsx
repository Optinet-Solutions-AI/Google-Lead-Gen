import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createServiceClient } from '@/lib/supabase/service'
import { Pagination } from '../../monday/_components/pagination'
import { SearchBar } from '../../monday/_components/search-bar'
import { LeadsTable } from '../../leads/_components/leads-table'
import {
  DEFAULT_LEAD_PAGE_SIZE,
  LEAD_PAGE_SIZES,
  queryLeads,
} from '../../leads/_lib/query'
import { EnrichmentStages } from '../_components/enrichment-stages'

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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'captcha'
  attempts: number
  batch_id: number | null
  claimed_by: string | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  result_summary: Record<string, unknown> | null
  created_at: string
}

const STATUS_STYLES: Record<Job['status'], string> = {
  pending: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  running: 'bg-[color:var(--color-accent)]/50 text-[color:var(--color-text-primary)]',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  captcha: 'bg-amber-100 text-amber-800',
}

export const dynamic = 'force-dynamic'

export default async function ScrapeJobPage({ params, searchParams }: Props) {
  const { id } = await params
  const sp = await searchParams

  const svc = createServiceClient()
  const { data: jobRaw, error: jobError } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, pages, status, attempts, batch_id, claimed_by, started_at, completed_at, error_message, result_summary, created_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (jobError) throw jobError
  if (!jobRaw) notFound()
  const job = jobRaw as Job

  const page = clampInt(sp.page, 1, 1_000_000, 1)
  const size = clampEnum(sp.size, LEAD_PAGE_SIZES, DEFAULT_LEAD_PAGE_SIZE)
  const sort = typeof sp.sort === 'string' ? sp.sort : 'overall_position'
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'asc'
  const q = typeof sp.q === 'string' ? sp.q : ''
  const countryCode = typeof sp.country_code === 'string' ? sp.country_code : ''
  const resultType = typeof sp.result_type === 'string' ? sp.result_type : ''

  const { rows, total } = await queryLeads({
    page,
    size,
    sort,
    order,
    q,
    countryCode,
    resultType,
    scrapeJobId: id,
  })

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
            <h1 className="truncate text-[16px] font-semibold text-[color:var(--color-text-primary)]">
              {job.keyword}
            </h1>
            <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
              {job.country_code} · {job.pages} page{job.pages === 1 ? '' : 's'}
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

      <EnrichmentStages jobId={job.id} />

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <SearchBar />
      </div>

      <LeadsTable rows={rows} jobContext />

      <Pagination page={page} size={size} total={total} pageSizeOptions={LEAD_PAGE_SIZES} />
    </div>
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
      {job.error_message && (
        <div className="col-span-full mt-1 rounded-md bg-red-50 px-3 py-2 text-red-700">
          <span className="font-medium">Error:</span> {job.error_message}
        </div>
      )}
    </dl>
  )
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
