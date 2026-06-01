'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, CheckSquare, Square, User } from 'lucide-react'
import { VISIBLE_PIPELINE_STAGES, type EnrichmentStatus, type ScrapeJob } from '../_lib/pipeline'
import { BulkScrapeActionsBar } from './bulk-actions-bar'
import { JobActionsButton } from './job-row-actions'

type Props = {
  jobs: ScrapeJob[]
  /** When true, show the "Select rows" toggle + bulk-action bar. The
   *  underlying server actions are independently gated, but hiding the
   *  UI from non-admins keeps the table cleaner for normal users. */
  isAdmin?: boolean
}

const STATUS_STYLES: Record<ScrapeJob['status'], string> = {
  pending: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  running: 'bg-[color:var(--color-accent)]/50 text-[color:var(--color-text-primary)]',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  captcha: 'bg-amber-100 text-amber-800',
  paused: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
}

/** Effective status that folds the enrichment-chain state into the badge.
 *  Without this, scrape-completed jobs flip to green "completed" the instant
 *  scraping ends — which is misleading when enrichment is still running. */
function displayStatus(job: ScrapeJob): { label: string; style: string; title?: string } {
  // Captcha auto-retrying: status is 'pending' (re-queued by the RPC)
  // but captcha_attempts > 0 means previous runs hit captcha. Show
  // the progress so users see something is happening.
  if (job.status === 'pending' && (job.captcha_attempts ?? 0) > 0) {
    return {
      label: `captcha · retrying ${job.captcha_attempts}/10`,
      style: 'bg-amber-100 text-amber-800',
      title:
        'Auto-retrying after a captcha hit; the proxy IP rotates per session so the next attempt may succeed.',
    }
  }
  if (job.status === 'captcha') {
    return {
      label: `captcha · ${job.captcha_attempts ?? 0} retries`,
      style: STATUS_STYLES.captcha,
      title:
        'Captcha hit the auto-retry cap (10). Open the kebab → Try again to reset and retry.',
    }
  }
  if (job.status !== 'completed') {
    const attempts = job.attempts > 1 ? ` · ${job.attempts}` : ''
    return { label: `${job.status}${attempts}`, style: STATUS_STYLES[job.status] }
  }
  if (!job.with_enrichment) {
    return { label: 'completed', style: STATUS_STYLES.completed }
  }
  switch (job.enrichment_status) {
    case 'complete':
      return { label: 'completed', style: STATUS_STYLES.completed }
    case 'affiliate_running':
      return {
        label: 'enriching · affiliate',
        style: 'bg-sky-100 text-sky-800',
        title: 'Scrape done; affiliate-detection stage running',
      }
    case 'rooster_running':
      return {
        label: 'enriching · rooster',
        style: 'bg-sky-100 text-sky-800',
        title: 'Scrape done; Rooster brand check running. S-tag and Contact extraction are operator-triggered from the job page.',
      }
    // Legacy statuses from before the chain shrank to 1–3. Treated
    // identically to rooster_running — chain only waits on rooster now.
    case 'all_running':
    case 'contact_running':
      return {
        label: 'enriching · rooster',
        style: 'bg-sky-100 text-sky-800',
        title: 'Legacy chain status; auto pipeline now stops at Rooster. S-tag and Contact extraction are manual.',
      }
    case 'pending':
    case null:
    default:
      return {
        label: 'enrichment queued',
        style: 'bg-amber-100 text-amber-800',
        title: 'Scrape done; orchestrator will start enrichment within ~1 min',
      }
  }
}

function StatusBadge({ job }: { job: ScrapeJob }) {
  const { label, style, title } = displayStatus(job)
  return (
    <span
      title={title}
      className={[
        'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium',
        style,
      ].join(' ')}
    >
      {label}
    </span>
  )
}

/** Tiny icon shown next to the status when a captcha was hit during the
 *  scrape: a robot when 2Captcha cleared it automatically, a person when
 *  an operator did. Renders nothing when no captcha was recorded. */
function CaptchaSolveMarker({ job }: { job: ScrapeJob }) {
  if (!job.captcha_solved_by) return null
  // A scrape can hit several captchas across its pages. If it ultimately
  // stalled/failed ON a captcha, showing "solved by a person" next to a
  // "nobody solved the captcha" error reads as a contradiction — so only
  // show the marker when the solve actually let the scrape proceed.
  if (job.status === 'captcha' || job.status === 'failed') return null
  const isBot = job.captcha_solved_by === 'auto_2captcha'
  return (
    <span
      className="inline-flex items-center"
      title={
        isBot
          ? 'A captcha during this scrape was solved automatically by 2Captcha'
          : 'A captcha during this scrape was solved by a person'
      }
    >
      {isBot ? (
        <Bot className="h-3 w-3 text-indigo-500" />
      ) : (
        <User className="h-3 w-3 text-emerald-600" />
      )}
    </span>
  )
}

function EngineBadge({ engine }: { engine: ScrapeJob['search_engine'] }) {
  const e = engine ?? 'google'
  const styles =
    e === 'bing'
      ? 'bg-cyan-100 text-cyan-800'
      : e === 'youtube'
        ? 'bg-red-100 text-red-800'
        : e === 'twitch'
          ? 'bg-purple-100 text-purple-800'
          : e === 'kick'
            ? 'bg-green-100 text-green-800'
            : 'bg-blue-100 text-blue-800'
  const label = e === 'youtube' ? 'YouTube' : e === 'bing' ? 'Bing' : e === 'twitch' ? 'Twitch' : e === 'kick' ? 'Kick' : 'Google'
  return (
    <span
      title={`Scraped on ${label}`}
      className={['inline-block rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide', styles].join(' ')}
    >
      {label}
    </span>
  )
}

function ViewModeBadge({ mode }: { mode: ScrapeJob['view_mode'] }) {
  // Outlined (border + transparent bg) so the chip reads as visually
  // distinct from the filled engine chip when stacked in the same cell.
  // Hues also picked to stay clear of the engine blue/cyan: orange for
  // "both", violet for mobile, slate for desktop.
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
      className={['inline-block rounded-full border bg-transparent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide', style].join(' ')}
    >
      {m}
    </span>
  )
}

function PipelineBadges({
  status,
  enrichment,
}: {
  status: ScrapeJob['status']
  enrichment: EnrichmentStatus
}) {
  if (status !== 'completed') {
    return <span className="text-[color:var(--color-text-secondary)]">—</span>
  }
  return (
    <div className="flex items-center gap-1">
      {VISIBLE_PIPELINE_STAGES.map(stage => {
        const applied = enrichment[stage.key] === true
        return (
          <span
            key={stage.key}
            title={`${stage.label}: ${applied ? 'applied' : 'not yet'}`}
            className={[
              'inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-medium',
              applied
                ? 'bg-emerald-100 text-emerald-700'
                : 'border border-dashed border-[color:var(--color-border)] text-[color:var(--color-text-secondary)]',
            ].join(' ')}
          >
            {applied ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
          </span>
        )
      })}
    </div>
  )
}

export function JobsTable({ jobs, isAdmin = false }: Props) {
  // Bulk-select state — only meaningful when isAdmin is true. Drop
  // any selected ids that aren't on the current page so paging away
  // doesn't keep stale selections.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const rowIdSig = useMemo(() => jobs.map(j => j.id).join(','), [jobs])
  useEffect(() => {
    setSelectedIds(prev => {
      const valid = new Set(jobs.map(j => j.id))
      const next = new Set<string>()
      for (const id of prev) if (valid.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdSig])

  const visibleIds = useMemo(() => jobs.map(j => j.id), [jobs])
  const allChecked = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
  const toggleAll = () => {
    setSelectedIds(prev => {
      if (allChecked) {
        const next = new Set(prev)
        for (const id of visibleIds) next.delete(id)
        return next
      }
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })
  }
  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-10 text-center text-[12px] text-[color:var(--color-text-secondary)]">
        No scrapes queued yet. Submit one above.
      </div>
    )
  }

  return (
    <>
      {/* Admin-only: select-mode toggle + bulk-action bar. The toggle
       *  is hidden entirely for non-admins so the table looks clean. */}
      {isAdmin && (
        <div className="hidden items-center justify-end md:flex">
          <button
            type="button"
            onClick={() => {
              setSelectMode(s => !s)
              if (selectMode) setSelectedIds(new Set())
            }}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
              selectMode
                ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
                : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
            ].join(' ')}
            title={selectMode ? 'Hide selection checkboxes' : 'Show selection checkboxes for bulk actions (admin)'}
          >
            {selectMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
            {selectMode ? 'Selecting' : 'Select rows'}
          </button>
        </div>
      )}

      {isAdmin && selectMode && selectedIds.size > 0 && (
        <BulkScrapeActionsBar
          selectedIds={Array.from(selectedIds)}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* No inner overflow: per CSS spec, overflow-x:auto + overflow-y:visible
       *  still promotes the y-axis to a scroll container, which traps the
       *  sticky <th> inside the wrapper. On tall tables (size=100 / size=All)
       *  scrolling the page lifts the whole wrapper — and the "sticky" header
       *  — above the viewport. Letting the page own both axes keeps per-cell
       *  sticky pinned to the viewport. Wide tables fall back to page-level
       *  horizontal scroll. */}
      <div className="hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] md:block">
        <table className="w-full border-collapse text-[11px]">
          {/* Sticky lives on each <th> below (not on <thead>). HTML
           *  table layout doesn't reliably honour position:sticky on
           *  the row-group element across browsers; per-cell sticky
           *  works everywhere. The bg here keeps the row dark when
           *  the cells transition into stuck state. */}
          <thead className="bg-[color:var(--color-border-strong)]">
            <tr>
              {selectMode && (
                <Th>
                  <input
                    type="checkbox"
                    aria-label={allChecked ? 'Deselect all visible' : 'Select all visible'}
                    checked={allChecked}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--color-accent)]"
                  />
                </Th>
              )}
              <Th>{''}</Th>
              <Th>Keyword</Th>
              <Th>Country</Th>
              <Th>Engine</Th>
              <Th>View</Th>
              <Th>Pages</Th>
              <Th>Status</Th>
              <Th>Started</Th>
              <Th>Duration</Th>
              <Th>Results</Th>
              <Th>Pipeline</Th>
              <Th>Batch</Th>
              <Th>Error</Th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => {
              const href = `/scrape/${job.id}`
              const isSelected = selectedIds.has(job.id)
              return (
                <tr
                  key={job.id}
                  className={[
                    'group border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]',
                    selectMode && isSelected ? 'bg-[color:var(--color-accent)]/10' : '',
                  ].join(' ')}
                >
                  {selectMode && (
                    <td className="w-8 px-2 py-1 align-middle">
                      <input
                        type="checkbox"
                        aria-label={`Select job ${job.keyword}`}
                        checked={isSelected}
                        onChange={() => toggleOne(job.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--color-accent)]"
                      />
                    </td>
                  )}
                  <td className="w-8 px-1 py-1 align-middle">
                    <JobActionsButton job={job} />
                  </td>
                <LinkTd
                  href={href}
                  className="max-w-[280px] truncate"
                  title={(() => {
                    const by = job.created_by_display || job.created_by_username
                    return by ? `${job.keyword} — queued by ${by}` : job.keyword
                  })()}
                >
                  <span className="block truncate">{job.keyword}</span>
                  {(job.created_by_display || job.created_by_username) && (
                    <span className="block truncate text-[10px] text-[color:var(--color-text-secondary)]">
                      by {job.created_by_display || job.created_by_username}
                    </span>
                  )}
                </LinkTd>
                <LinkTd href={href}>{job.country_code}</LinkTd>
                <LinkTd href={href}>
                  <EngineBadge engine={job.search_engine} />
                </LinkTd>
                <LinkTd href={href}>
                  <ViewModeBadge mode={job.view_mode} />
                </LinkTd>
                <LinkTd href={href}>{job.pages}</LinkTd>
                <LinkTd href={href}>
                  <span className="inline-flex items-center gap-1">
                    <StatusBadge job={job} />
                    <CaptchaSolveMarker job={job} />
                  </span>
                </LinkTd>
                <LinkTd
                  href={href}
                  title={startedCellTooltip(job)}
                >
                  <StartedCell job={job} />
                </LinkTd>
                <td className="p-0 align-middle">
                  <DurationCell job={job} href={href} />
                </td>
                <LinkTd href={href}>
                  <ResultsCell summary={job.result_summary} />
                </LinkTd>
                <LinkTd href={href}>
                  <PipelineBadges status={job.status} enrichment={job.enrichment} />
                </LinkTd>
                <LinkTd href={href}>{job.batch_id ?? '—'}</LinkTd>
                <LinkTd
                  href={href}
                  className="max-w-[280px] truncate text-red-700"
                  title={job.error_message ?? ''}
                >
                  {job.error_message ?? ''}
                </LinkTd>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </>
  )
}

// Mobile card layout below — same data, stacked.
export function JobsCardList({ jobs }: Props) {
  if (jobs.length === 0) return null
  return (
    <div className="flex flex-col gap-2 md:hidden">
      {jobs.map(job => (
        <Link
          key={job.id}
          href={`/scrape/${job.id}`}
          className="block rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 transition-colors hover:bg-[color:var(--color-bg-secondary)]"
        >
          <div className="mb-1.5 flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-1">
              <JobActionsButton job={job} />
              <p className="truncate pt-0.5 text-[13px] font-medium text-[color:var(--color-text-primary)]">
                {job.keyword}
              </p>
            </div>
            <span className="inline-flex items-center gap-1">
              <StatusBadge job={job} />
              <CaptchaSolveMarker job={job} />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--color-text-secondary)]">
            <span>{job.country_code}</span>
            <EngineBadge engine={job.search_engine} />
            <ViewModeBadge mode={job.view_mode} />
            <span>{job.pages} {job.pages === 1 ? 'page' : 'pages'}</span>
            <span title={mobileDurationTooltip(job)} suppressHydrationWarning>
              {formatTotalDuration(job)}
            </span>
            <ResultsCell summary={job.result_summary} mobile />
          </div>
          {job.status === 'completed' && (
            <div className="mt-1.5">
              <PipelineBadges status={job.status} enrichment={job.enrichment} />
            </div>
          )}
          {job.error_message && (
            <p className="mt-1.5 text-[11px] text-red-700" title={job.error_message}>
              {job.error_message.length > 100
                ? job.error_message.slice(0, 100) + '…'
                : job.error_message}
            </p>
          )}
        </Link>
      ))}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      // Per-cell sticky: pins to the viewport top as the page scrolls.
      // Background colour is non-negotiable here — the cell would be
      // transparent in the stuck state and body rows would bleed
      // through underneath.
      className="sticky top-0 z-20 whitespace-nowrap border-b border-[color:var(--color-border-strong)] bg-[color:var(--color-border-strong)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]"
    >
      {children}
    </th>
  )
}

/** <td><Link> — whole cell becomes the click target for row navigation.
 *  prefetch={false}: at "Rows: All" the table has ~10 Links per row × hundreds
 *  of rows, and Next prefetches every visible Link by default. That floods
 *  Chrome with "resource was preloaded but not used" warnings and wastes
 *  bandwidth on routes the user never opens. Navigation still works on click;
 *  it's just not warmed up ahead of time. */
function LinkTd({
  href,
  children,
  className,
  title,
}: {
  href: string
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <td className="p-0 align-middle">
      <Link
        href={href}
        prefetch={false}
        {...(title ? { title } : {})}
        className={['block whitespace-nowrap px-3 py-2', className ?? ''].join(' ')}
      >
        {children}
      </Link>
    </td>
  )
}

function totalResults(summary: Record<string, unknown> | null): number | null {
  if (!summary) return null
  const v = summary['total_results']
  if (typeof v === 'number') return v
  return null
}

function asNumber(summary: Record<string, unknown> | null, key: string): number | null {
  if (!summary) return null
  const v = summary[key]
  return typeof v === 'number' ? v : null
}

function ResultsCell({
  summary,
  mobile = false,
}: {
  summary: Record<string, unknown> | null
  mobile?: boolean
}) {
  const total = totalResults(summary)
  if (total === null) return <span>—</span>
  const ppc = asNumber(summary, 'ppc')
  const organic = asNumber(summary, 'organic')

  if (mobile) {
    return (
      <span>
        {total} results
        {(ppc !== null || organic !== null) && (
          <span className="text-[color:var(--color-text-secondary)]">
            {' · '}
            {ppc ?? 0} PPC · {organic ?? 0} Org
          </span>
        )}
      </span>
    )
  }
  return (
    <span className="whitespace-nowrap">
      {total}
      {(ppc !== null || organic !== null) && (
        <span className="ml-1 text-[10px] text-[color:var(--color-text-secondary)]">
          ({ppc ?? 0} PPC · {organic ?? 0} Org)
        </span>
      )}
    </span>
  )
}

/** Cell renderer — total scrape+enrichment duration with a hover popover
 *  showing per-stage breakdown. Falls back to the raw scrape window when
 *  no enrichment timings are available (non-completed jobs, jobs without
 *  with_enrichment, or completed jobs that haven't been enriched yet). */
function DurationCell({ job, href }: { job: ScrapeJob; href: string }) {
  const total = formatTotalDuration(job)
  const stages = stageBreakdown(job)
  const showPopover = stages.length > 0
  return (
    <div className="group/dur relative">
      <Link
        href={href}
        className="block whitespace-nowrap px-3 py-2"
      >
        {/* Running jobs compute their duration from `Date.now()`, so the
         *  server's render time and the client's hydration time diverge
         *  by ~1s and trigger a hydration mismatch. The auto-refresh poll
         *  re-renders this every 5s anyway, so we just suppress the
         *  one-time mismatch warning on the live text. */}
        <span suppressHydrationWarning>{total}</span>
        {job.stage_timings?.enrichment_in_progress && (
          <span className="ml-1 text-[9px] text-[color:var(--color-text-secondary)]">
            +
          </span>
        )}
      </Link>
      {showPopover && (
        <div
          role="tooltip"
          className="pointer-events-none invisible absolute left-1/2 top-full z-20 mt-1 w-[210px] -translate-x-1/2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-2 text-[10px] text-[color:var(--color-text-primary)] opacity-0 shadow-lg transition-opacity group-hover/dur:visible group-hover/dur:opacity-100"
        >
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Stage breakdown
          </p>
          <table className="w-full">
            <tbody>
              {stages.map(s => (
                <tr key={s.label}>
                  <td className="py-0.5 pr-2 text-[color:var(--color-text-secondary)]">{s.label}</td>
                  <td className="py-0.5 text-right font-mono">{s.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {job.stage_timings?.enrichment_in_progress && (
            <p className="mt-1.5 border-t border-[color:var(--color-border)] pt-1 text-[9px] italic text-[color:var(--color-text-secondary)]">
              Enrichment still in flight — values update as rows land.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Total wall-clock from scrape start to the latest stage end, or the
 *  scrape-only window when no enrichment timings exist. */
function formatTotalDuration(job: ScrapeJob): string {
  const t = job.stage_timings
  if (t?.total_ms != null) return formatMs(t.total_ms)
  return formatDuration(job.started_at, job.completed_at)
}

/** Per-stage rows for the hover popover. Returns [] when there's nothing
 *  meaningful to show (e.g. job hasn't completed scraping yet). */
function stageBreakdown(job: ScrapeJob): Array<{ label: string; value: string }> {
  const t = job.stage_timings
  if (!t) return []
  const rows: Array<{ label: string; value: string }> = []
  const push = (label: string, ms: number | null) => {
    if (ms == null) return
    rows.push({ label, value: formatMs(ms) })
  }
  push('Scrape', t.scrape_ms)
  push('Monday check', t.monday_ms)
  push('Affiliate', t.affiliate_ms)
  push('Rooster', t.rooster_ms)
  push('S-tags', t.stag_ms)
  // 'S-tag check' breakdown row hidden until the verification stage is
  // re-surfaced in the UI. Timing is still computed in fetchStageTimings.
  push('Contacts', t.contact_ms)
  if (rows.length === 0) return []
  if (t.total_ms != null) {
    rows.push({ label: 'Total', value: formatMs(t.total_ms) })
  }
  return rows
}

/** Title-attribute fallback for the mobile card list. */
function mobileDurationTooltip(job: ScrapeJob): string {
  const stages = stageBreakdown(job)
  if (stages.length === 0) return ''
  return stages.map(s => `${s.label}: ${s.value}`).join('\n')
}

/** ms → human-readable. <60s → "Ns", else "Nm Ns". */
function formatMs(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

/** Full date + time, e.g. "Apr 29, 14:32" — preferred for table cells. */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/** Started-column renderer. Pending jobs never set `started_at`, and a
 *  failed job's claim is cleared on retry — both leave the cell blank.
 *  Fall back to `created_at` (queue time) so the user always sees when
 *  the scrape entered the system, and italicise to flag the fallback. */
function StartedCell({ job }: { job: ScrapeJob }) {
  if (job.started_at) {
    return <span suppressHydrationWarning>{formatDateTime(job.started_at)}</span>
  }
  return (
    <span
      suppressHydrationWarning
      className="italic text-[color:var(--color-text-secondary)]"
    >
      {formatDateTime(job.created_at)}
    </span>
  )
}

function startedCellTooltip(job: ScrapeJob): string {
  if (job.started_at) {
    return `Started: ${formatTooltipDateTime(job.started_at)} — ${statusPhrase(job)}`
  }
  return `Queued at ${formatTooltipDateTime(job.created_at)} — ${statusPhrase(job)}`
}

/** Short human phrase describing the job's current state — appended to
 *  the Started-cell tooltip so users see why the cell value is what it is. */
function statusPhrase(job: ScrapeJob): string {
  switch (job.status) {
    case 'pending':
      return (job.captcha_attempts ?? 0) > 0
        ? 'auto-retrying after a captcha hit'
        : 'scrape has not started yet'
    case 'running':
      return 'scrape is currently running'
    case 'completed':
      return 'scrape completed'
    case 'failed':
      return `scrape failed${job.attempts > 1 ? ` after ${job.attempts} attempts` : ''}`
    case 'captcha':
      return 'scrape stopped — captcha hit the retry cap'
    case 'paused':
      return 'scrape is paused'
    case 'cancelled':
      return 'scrape was cancelled'
    default:
      return job.status
  }
}

/** Tooltip format: longer than the cell (adds year + seconds) but still
 *  human-readable. e.g. "May 26, 2026, 03:44:52 PM". */
function formatTooltipDateTime(iso: string | null): string {
  if (!iso) return '—'
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

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  if (Number.isNaN(start)) return '—'
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}
