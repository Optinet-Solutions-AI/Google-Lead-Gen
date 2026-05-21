'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, User } from 'lucide-react'
import type {
  BoardEnrichmentJob,
  BoardWorker,
} from '../_lib/queries'
import type { ScrapeJob } from '../_lib/pipeline'

// ---------------------------------------------------------------------------
// Compact badges used on Kanban cards. We re-implement these instead of
// importing from jobs-table.tsx so the table view's components stay
// internal and we can size them smaller for the card density.
// ---------------------------------------------------------------------------
const STATUS_STYLES: Record<ScrapeJob['status'], string> = {
  pending: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  running: 'bg-[color:var(--color-accent)]/50 text-[color:var(--color-text-primary)]',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  captcha: 'bg-amber-100 text-amber-800',
  paused: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
}

function StatusPill({ status }: { status: ScrapeJob['status'] }) {
  return (
    <span
      className={[
        'inline-block rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        STATUS_STYLES[status],
      ].join(' ')}
    >
      {status}
    </span>
  )
}

function EngineDot({ engine }: { engine: ScrapeJob['search_engine'] }) {
  const e = engine ?? 'google'
  const styles =
    e === 'bing'
      ? 'bg-cyan-500'
      : e === 'youtube'
        ? 'bg-red-500'
        : 'bg-blue-500'
  const label = e === 'youtube' ? 'YT' : e === 'bing' ? 'Bing' : 'Google'
  return (
    <span
      title={`Engine: ${label}`}
      className={[
        'inline-block h-2 w-2 rounded-full',
        styles,
      ].join(' ')}
    />
  )
}

function ViewModeBadge({ mode }: { mode: ScrapeJob['view_mode'] }) {
  const m = mode ?? 'both'
  const style =
    m === 'mobile'
      ? 'border-violet-400 text-violet-700'
      : m === 'both'
        ? 'border-orange-400 text-orange-700'
        : 'border-slate-400 text-slate-600'
  return (
    <span
      title={`view_mode: ${m}`}
      className={[
        'inline-block rounded border bg-transparent px-1 py-0 text-[9px] font-semibold uppercase tracking-wide',
        style,
      ].join(' ')}
    >
      {m}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return ''
  const diffMs = Date.now() - ts
  const secs = Math.max(0, Math.floor(diffMs / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function durationBetween(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return ''
  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  const secs = Math.floor((end - start) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------
type Variant = 'pending' | 'next' | 'running' | 'completed' | 'failed'

type KanbanCardProps = {
  job: ScrapeJob
  variant: Variant
}

export function KanbanCard({ job, variant }: KanbanCardProps) {
  const [expanded, setExpanded] = useState(false)
  const errorPreview = job.error_message?.slice(0, 200) ?? null
  const totals = job.result_summary as {
    total_results?: number
    organic_results?: number
    ppc_results?: number
    mobile_only_results?: number
    cross_device_results?: number
    mobile_pass_skipped?: string | null
  } | null

  return (
    <article
      className={[
        'min-w-0 max-w-full overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-2 transition-shadow',
        expanded ? 'shadow-md' : 'shadow-sm hover:shadow-md',
      ].join(' ')}
    >
      {/* Header row — toggles expand */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex w-full items-start gap-1.5 text-left"
        aria-expanded={expanded}
      >
        <span className="mt-0.5 shrink-0 text-[color:var(--color-text-secondary)]">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <EngineDot engine={job.search_engine} />
            <span className="font-mono text-[10px] font-semibold uppercase text-[color:var(--color-text-secondary)]">
              {job.country_code}
            </span>
            <ViewModeBadge mode={job.view_mode} />
            <StatusPill status={job.status} />
          </span>
          <span
            className="mt-0.5 block truncate text-[12px] font-medium text-[color:var(--color-text-primary)]"
            title={job.keyword}
          >
            {job.keyword}
          </span>
        </span>
      </button>

      {/* Compact footer — always visible */}
      <p className="mt-1 ml-[18px] flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
        {variant === 'pending' && (
          <>queued {relativeTime(job.created_at)}</>
        )}
        {variant === 'next' && (
          <>
            queued {relativeTime(job.created_at)}
            {job.priority > 0 && <>· priority {job.priority}</>}
          </>
        )}
        {variant === 'running' && job.started_at && (
          <>
            running {relativeTime(job.started_at)}
            {job.claimed_by && <>· {job.claimed_by}</>}
          </>
        )}
        {(variant === 'completed' || variant === 'failed') && job.completed_at && (
          <>
            {variant === 'completed' ? 'done' : variant} {relativeTime(job.completed_at)}
            {job.started_at && <>· {durationBetween(job.started_at, job.completed_at)}</>}
          </>
        )}
      </p>

      {/* Result counts — compact summary on completed cards */}
      {variant === 'completed' && totals && (
        <p className="mt-0.5 ml-[18px] flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
          <span>{totals.total_results ?? 0} leads</span>
          {(totals.ppc_results ?? 0) > 0 && <span>· {totals.ppc_results} PPC</span>}
          {(totals.organic_results ?? 0) > 0 && <span>· {totals.organic_results} organic</span>}
          {(totals.mobile_only_results ?? 0) > 0 && (
            <span className="text-violet-700">· {totals.mobile_only_results} mobile-only</span>
          )}
        </p>
      )}

      {/* Expanded body */}
      {expanded && (
        <div className="mt-2 ml-[18px] flex flex-col gap-1.5 border-t border-[color:var(--color-border)] pt-2 text-[11px]">
          <KV label="Keyword" value={job.keyword} mono />
          <KV label="Country" value={job.country_code} />
          <KV label="Language" value={job.language ?? '—'} />
          <KV label="Pages" value={String(job.pages)} />
          {(job.priority ?? 0) > 0 && <KV label="Priority" value={String(job.priority)} />}
          {job.created_by_display && (
            <KV
              label="Owner"
              value={
                <span className="inline-flex items-center gap-1">
                  <User className="h-3 w-3 text-[color:var(--color-text-secondary)]" />
                  {job.created_by_display}
                </span>
              }
            />
          )}
          {job.attempts > 0 && <KV label="Attempts" value={String(job.attempts)} />}
          {(job.captcha_attempts ?? 0) > 0 && (
            <KV label="Captcha retries" value={`${job.captcha_attempts} / 10`} />
          )}
          {variant === 'running' && job.started_at && (
            <KV label="Running for" value={durationBetween(job.started_at, new Date().toISOString())} />
          )}
          {variant === 'completed' && totals && (
            <>
              <KV
                label="Results"
                value={
                  <span>
                    {totals.total_results ?? 0} ({totals.ppc_results ?? 0} PPC / {totals.organic_results ?? 0} Organic)
                  </span>
                }
              />
              {(totals.mobile_only_results ?? 0) > 0 && (
                <KV label="Mobile-only" value={String(totals.mobile_only_results)} />
              )}
              {(totals.cross_device_results ?? 0) > 0 && (
                <KV label="Cross-device" value={String(totals.cross_device_results)} />
              )}
              {totals.mobile_pass_skipped && (
                <KV label="Mobile pass" value={`skipped (${totals.mobile_pass_skipped})`} />
              )}
            </>
          )}
          {variant === 'failed' && errorPreview && (
            <p
              className="overflow-hidden whitespace-pre-wrap break-all rounded-md bg-red-50 px-2 py-1 text-[10px] leading-snug text-red-700"
              title={job.error_message ?? undefined}
            >
              {errorPreview}
              {(job.error_message?.length ?? 0) > 200 ? '…' : ''}
            </p>
          )}

          <div className="mt-1 flex flex-wrap gap-2">
            <Link
              href={`/scrape/${job.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[10px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
            >
              <ExternalLink className="h-3 w-3" />
              Open job
            </Link>
          </div>
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Idle worker card
// ---------------------------------------------------------------------------
export function IdleWorkerCard({ worker }: { worker: BoardWorker }) {
  return (
    <article className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/40 p-2">
      <p className="flex items-center gap-1.5 text-[10px]">
        <span
          className={[
            'inline-block h-2 w-2 rounded-full',
            worker.kind === 'enrichment' ? 'bg-emerald-400' : 'bg-blue-400',
          ].join(' ')}
        />
        <span className="font-mono font-semibold text-[color:var(--color-text-primary)]">
          {worker.worker_id}
        </span>
        <span className="text-[color:var(--color-text-secondary)]">
          ({worker.kind})
        </span>
      </p>
      {worker.last_seen_at && (
        <p className="mt-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
          idle · last active {relativeTime(worker.last_seen_at)}
        </p>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Enrichment-job card (rendered alongside scrape running cards)
// ---------------------------------------------------------------------------
export function EnrichmentRunningCard({ job }: { job: BoardEnrichmentJob }) {
  const url = job.url ?? '—'
  const short = url.length > 32 ? url.slice(0, 32) + '…' : url
  const stages = job.process_stages.join(', ') || '—'
  return (
    <article className="rounded-md border border-[color:var(--color-border)] bg-emerald-50/30 p-2">
      <p className="flex items-center gap-1.5 text-[10px]">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
        <span className="font-mono font-semibold uppercase text-[color:var(--color-text-secondary)]">
          ENRICH
        </span>
        {job.country_code && (
          <span className="font-mono font-semibold uppercase text-[color:var(--color-text-secondary)]">
            · {job.country_code}
          </span>
        )}
      </p>
      <p
        className="mt-0.5 truncate text-[12px] font-medium text-[color:var(--color-text-primary)]"
        title={url}
      >
        {short}
      </p>
      <p className="mt-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
        {stages}
        {job.claimed_by && <> · {job.claimed_by}</>}
        {job.started_at && <> · {relativeTime(job.started_at)}</>}
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------
// KV helper
// ---------------------------------------------------------------------------
function KV({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <p className="flex gap-2">
      <span className="shrink-0 text-[color:var(--color-text-secondary)]">{label}:</span>
      <span
        className={[
          'min-w-0 flex-1 break-words text-[color:var(--color-text-primary)]',
          mono ? 'font-mono' : '',
        ].join(' ')}
      >
        {value}
      </span>
    </p>
  )
}
