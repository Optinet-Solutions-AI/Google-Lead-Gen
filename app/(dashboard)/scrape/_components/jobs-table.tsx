'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  Ban,
  Bot,
  Check,
  CheckSquare,
  ExternalLink,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  Trash2,
  User,
  XCircle,
} from 'lucide-react'
import {
  KICK_PIPELINE_STAGES,
  SOCIAL_PIPELINE_STAGES,
  VISIBLE_PIPELINE_STAGES,
  isSocialBadgeEngine,
  type EnrichmentStatus,
  type KickPipelineStatus,
  type ScrapeJob,
  type SocialPipelineStatus,
} from '../_lib/pipeline'
import {
  bulkDeleteScrapeJobs,
  bulkPushJobLeadsToNotRelevant,
  bulkRerunScrapeJobs,
} from '../actions'
import { isInteractiveTarget } from '@/lib/dom/is-interactive-target'
import {
  RowContextMenu,
  type ContextMenuAction,
} from '../../_components/row-context-menu'
import { BulkScrapeActionsBar } from './bulk-actions-bar'
import { JobActionsButton } from './job-row-actions'
import { ReviewedCheckbox } from './reviewed-checkbox'

type Props = {
  jobs: ScrapeJob[]
  /** When true, show the "Select rows" toggle + bulk-action bar. The
   *  underlying server actions are independently gated, but hiding the
   *  UI from non-admins keeps the table cleaner for normal users. */
  isAdmin?: boolean
  /** Pagination metadata to enable infinite scroll. When provided AND
   *  size > 0 AND infiniteScrollEnabled, an IntersectionObserver near
   *  the bottom of the table fetches the next page from /api/jobs and
   *  appends rows. Otherwise the table renders only what was
   *  server-rendered and the operator pages via the chevrons. */
  pageInfo?: { page: number; size: number; total: number }
  /** Per-user "auto-load on scroll" preference (default false). When
   *  false, the Rows picker is a hard limit and the sentinel never
   *  renders. Toggled in /account/password. */
  infiniteScrollEnabled?: boolean
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
function OutcomeMarker({ job }: { job: ScrapeJob }) {
  // Stopped on a captcha it couldn't get past — auto-retries exhausted or
  // a human checkpoint timed out. One neutral "not solved" marker, shown
  // straight off the job status (no contradiction with the error).
  if (job.status === 'captcha') {
    return (
      <span
        className="inline-flex items-center"
        title="A captcha appeared and couldn't be solved, so the scrape stopped. Open the menu (⋮) → Try again to retry."
      >
        <ShieldAlert className="h-3 w-3 text-amber-600" />
      </span>
    )
  }
  // Failed for some other reason (timeout, worker restart, error).
  if (job.status === 'failed') {
    return (
      <span
        className="inline-flex items-center"
        title="This scrape failed and stopped. Open the menu (⋮) → Try again to retry."
      >
        <XCircle className="h-3 w-3 text-red-500" />
      </span>
    )
  }
  // Cancelled by a person.
  if (job.status === 'cancelled') {
    return (
      <span
        className="inline-flex items-center"
        title="This scrape was cancelled."
      >
        <Ban className="h-3 w-3 text-slate-400" />
      </span>
    )
  }
  // "Solved by" icons only make sense on jobs that actually got their
  // results. On a job that failed/cancelled for some OTHER reason (e.g.
  // timeout, worker restart), a stray "solved by a bot" next to "failed"
  // is confusing — let the red status badge + error speak for those.
  if (job.status !== 'completed' && job.status !== 'running') return null
  if (!job.captcha_solved_by) return null
  const isBot = job.captcha_solved_by === 'auto_2captcha'
  // Labeled chip, not a bare icon: a green "completed" looks identical
  // whether a captcha was auto-solved, person-solved, or never hit, so
  // the origin needs to be readable at a glance, not hover-only.
  return (
    <span
      className={[
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        isBot ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700',
      ].join(' ')}
      title={
        isBot
          ? 'A captcha during this scrape was solved automatically by 2Captcha'
          : 'A captcha during this scrape was solved by a person'
      }
    >
      {isBot ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
      {isBot ? 'captcha · bot' : 'captcha · person'}
    </span>
  )
}

/** Colour for the Error-column text. While a job is still in flight
 *  (running, or pending after an auto-requeue) its error_message is a
 *  leftover from a PRIOR attempt the system is already retrying — render it
 *  muted, not in alarming red, so a healthy retry doesn't read as a failure.
 *  Only terminal states (failed / captcha / cancelled) get the red error. */
function errorTone(job: ScrapeJob): string {
  return job.status === 'running' || job.status === 'pending'
    ? 'italic text-[color:var(--color-text-secondary)]'
    : 'text-red-700'
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
            : e === 'x'
              ? 'bg-slate-200 text-slate-900'
              : e === 'facebook'
                ? 'bg-indigo-100 text-indigo-800'
                : e === 'tiktok'
                  ? 'bg-pink-100 text-pink-800'
                  : e === 'snapchat'
                    ? 'bg-yellow-100 text-yellow-800'
                    : e === 'telegram'
                      ? 'bg-sky-100 text-sky-800'
                      : 'bg-blue-100 text-blue-800'
  const label = e === 'youtube' ? 'YouTube' : e === 'bing' ? 'Bing' : e === 'twitch' ? 'Twitch' : e === 'kick' ? 'Kick' : e === 'x' ? 'X' : e === 'facebook' ? 'FB' : e === 'tiktok' ? 'TikTok' : e === 'snapchat' ? 'Snap' : e === 'telegram' ? 'TG' : 'Google'
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

/** One pipeline dot: filled emerald when the stage is done, dashed
 *  outline otherwise. Shared by the leads (5-dot) and Kick (3-dot)
 *  variants so they stay visually identical. */
function PipelineDot({ done, title }: { done: boolean; title: string }) {
  return (
    <span
      title={title}
      className={[
        'inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-medium',
        done
          ? 'bg-emerald-100 text-emerald-700'
          : 'border border-dashed border-[color:var(--color-border)] text-[color:var(--color-text-secondary)]',
      ].join(' ')}
    >
      {done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
    </span>
  )
}

/** Kick scrapes never touch the leads pipeline, so their five leads-dots
 *  would always read empty (misleadingly "0 of 5 done"). This variant
 *  shows Kick's own progression instead: Discovered → Enriched → Scored.
 *  Strict/sequential — a dot fills only when its stage is fully complete
 *  (enriched/scored counts must reach `discovered`). Enriched mirrors the
 *  detail panel's `pending === 0` so the two never disagree. */
function KickPipelineBadges({ kick }: { kick: KickPipelineStatus }) {
  const { discovered, enriched, scored } = kick
  const done: Record<(typeof KICK_PIPELINE_STAGES)[number]['key'], boolean> = {
    discovered: discovered > 0,
    enriched: discovered > 0 && enriched >= discovered,
    scored: discovered > 0 && scored >= discovered,
  }
  const counts: Record<(typeof KICK_PIPELINE_STAGES)[number]['key'], string> = {
    discovered: `${discovered} discovered`,
    enriched: `${enriched}/${discovered} enriched`,
    scored: `${scored}/${discovered} scored`,
  }
  return (
    <div className="flex items-center gap-1">
      {KICK_PIPELINE_STAGES.map(stage => (
        <PipelineDot
          key={stage.key}
          done={done[stage.key]}
          title={`${stage.label}: ${done[stage.key] ? 'done' : 'not yet'} (${counts[stage.key]})`}
        />
      ))}
    </div>
  )
}

/** Social engines (youtube/twitch/x/facebook/tiktok/snapchat/telegram) write
 *  to their own entity tables, not the leads table, so the 5-dot leads
 *  pipeline never fills and the row misreads as "not enriched". This 2-dot
 *  variant shows their real progression: Discovered → Scored & checked. The
 *  Scored dot only fills once the operator runs Phase-3 "Score & check" on
 *  the job detail — an empty Scored dot is the cue that step is still pending
 *  (and why the relevant-leads view is empty). */
function SocialPipelineBadges({ social }: { social: SocialPipelineStatus }) {
  const { discovered, scored } = social
  const done: Record<(typeof SOCIAL_PIPELINE_STAGES)[number]['key'], boolean> = {
    discovered: discovered > 0,
    scored: discovered > 0 && scored >= discovered,
  }
  const counts: Record<(typeof SOCIAL_PIPELINE_STAGES)[number]['key'], string> = {
    discovered: `${discovered} discovered`,
    scored: `${scored}/${discovered} scored`,
  }
  return (
    <div className="flex items-center gap-1">
      {SOCIAL_PIPELINE_STAGES.map(stage => (
        <PipelineDot
          key={stage.key}
          done={done[stage.key]}
          title={`${stage.label}: ${done[stage.key] ? 'done' : 'not yet'} (${counts[stage.key]})`}
        />
      ))}
    </div>
  )
}

function PipelineBadges({
  status,
  enrichment,
  engine,
  kick,
  social,
}: {
  status: ScrapeJob['status']
  enrichment: EnrichmentStatus
  engine: ScrapeJob['search_engine']
  kick: ScrapeJob['kick']
  social: ScrapeJob['social']
}) {
  if (status !== 'completed') {
    return <span className="text-[color:var(--color-text-secondary)]">—</span>
  }
  // Kick rows show their own 3-dot progression. If discovery returned no
  // streamers there's nothing to track — fall through to a dash.
  if (engine === 'kick') {
    return kick && kick.discovered > 0 ? (
      <KickPipelineBadges kick={kick} />
    ) : (
      <span className="text-[color:var(--color-text-secondary)]">—</span>
    )
  }
  // The other social engines show their own 2-dot progression for the same
  // reason — they don't touch the leads pipeline. Empty discovery → dash.
  if (isSocialBadgeEngine(engine)) {
    return social && social.discovered > 0 ? (
      <SocialPipelineBadges social={social} />
    ) : (
      <span className="text-[color:var(--color-text-secondary)]">—</span>
    )
  }
  return (
    <div className="flex items-center gap-1">
      {VISIBLE_PIPELINE_STAGES.map(stage => (
        <PipelineDot
          key={stage.key}
          done={enrichment[stage.key] === true}
          title={`${stage.label}: ${enrichment[stage.key] === true ? 'applied' : 'not yet'}`}
        />
      ))}
    </div>
  )
}

export function JobsTable({
  jobs: initialJobs,
  isAdmin = false,
  pageInfo,
  infiniteScrollEnabled = false,
}: Props) {
  // ----- Infinite scroll -----
  // The page server-renders the first chunk (size rows for `page`).
  // After hydration, an IntersectionObserver near the bottom of the
  // table fires a fetch for the NEXT page and appends the rows. The
  // URL stays on the server-rendered page so the pagination chevrons
  // below still work — they just jump straight to that page and
  // reset the appended list. Disabled when size === 0 ("All") because
  // the server already returns everything (up to the cap), and gated
  // on the per-user "auto-load on scroll" preference (default off).
  const scrollEnabled =
    infiniteScrollEnabled && pageInfo !== undefined && pageInfo.size > 0
  const [extraRows, setExtraRows] = useState<ScrapeJob[]>([])
  const [extraLoading, setExtraLoading] = useState(false)
  const [extraError, setExtraError] = useState<string | null>(null)
  const [nextPage, setNextPage] = useState<number>(
    pageInfo && pageInfo.size > 0 ? pageInfo.page + 1 : 2,
  )
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const sp = useSearchParams()
  const jobs = useMemo(
    () => (extraRows.length === 0 ? initialJobs : [...initialJobs, ...extraRows]),
    [initialJobs, extraRows],
  )

  // Reset the cursor whenever a NEW server-rendered chunk arrives —
  // filter change, sort change, size change, or a pagination chevron
  // click. Watching initialJobs' id signature (not the merged `jobs`
  // signature) avoids a reset-and-re-fetch loop while extras grow.
  const initialIdSig = useMemo(
    () => initialJobs.map(j => j.id).join(','),
    [initialJobs],
  )
  useEffect(() => {
    const resetCursor = () => {
      setExtraRows([])
      setExtraError(null)
      setNextPage(pageInfo && pageInfo.size > 0 ? pageInfo.page + 1 : 2)
    }
    resetCursor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIdSig, pageInfo?.page, pageInfo?.size])

  const accumulatedCount = initialJobs.length + extraRows.length
  const hasMore =
    scrollEnabled &&
    pageInfo!.size > 0 &&
    accumulatedCount < pageInfo!.total &&
    accumulatedCount > 0

  const loadMore = useCallback(async () => {
    if (!scrollEnabled || !pageInfo) return
    if (extraLoading) return
    if (!hasMore) return
    setExtraLoading(true)
    setExtraError(null)
    try {
      const params = new URLSearchParams(sp.toString())
      params.set('page', String(nextPage))
      params.set('size', String(pageInfo.size))
      const res = await fetch(`/api/jobs?${params.toString()}`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { rows: ScrapeJob[]; total: number }
      if (!Array.isArray(data.rows)) {
        throw new Error('Bad payload: rows is not an array.')
      }
      setExtraRows(prev => prev.concat(data.rows))
      setNextPage(p => p + 1)
    } catch (err) {
      setExtraError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtraLoading(false)
    }
  }, [extraLoading, hasMore, nextPage, pageInfo, scrollEnabled, sp])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    if (!hasMore) return
    const obs = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMore()
            break
          }
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 },
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [hasMore, loadMore])

  // Bulk-select state — only meaningful when isAdmin is true. Drop
  // any selected ids that aren't on the current page so paging away
  // doesn't keep stale selections.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Escape clears the active selection — explicit keyboard exit now
  // that plain row clicks no longer clear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (selectedIds.size === 0) return
      setSelectedIds(new Set())
      setSelectMode(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedIds.size])
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

  // ----- Alt+Click multi-select + click-on-selected context menu -----
  // Same UX shape as /leads. Alt+Click (Option+Click on Mac)
  // adds/removes from selection. Once any row is selected, plain
  // click on any row opens the actions menu at cursor instead of
  // navigating to /scrape/<id>. Right-click also opens the menu.
  // We avoid Ctrl/Cmd because users rely on those to open links
  // in a new tab.
  const [contextCursor, setContextCursor] = useState<{ x: number; y: number } | null>(null)
  const [contextRowId, setContextRowId] = useState<string | null>(null)
  const [actionPending, startAction] = useTransition()
  const [contextToast, setContextToast] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!contextToast) return
    const t = setTimeout(() => setContextToast(null), contextToast.ok ? 4000 : 8000)
    return () => clearTimeout(t)
  }, [contextToast])

  function onJobContextMenu(e: React.MouseEvent, jobId: string) {
    const isSelected = selectedIds.has(jobId)
    const hasSelection = selectedIds.size > 0

    // Right-click on a SELECTED row → pop the actions menu.
    if (hasSelection && isSelected) {
      e.preventDefault()
      setContextRowId(jobId)
      setContextCursor({ x: e.clientX, y: e.clientY })
      return
    }
    // Right-click on UNSELECTED row while selection is active →
    // suppress OS menu but don't disturb the selection.
    if (hasSelection && !isSelected) {
      e.preventDefault()
      return
    }
    // No selection → native OS menu.
  }

  function onJobCheckboxClick(e: React.MouseEvent, jobId: string) {
    // Exception to "left-click clears": clicking the checkbox ADDS
    // (or toggles) the row instead. stopPropagation prevents the
    // row-level click handler from running and clearing the
    // selection.
    e.stopPropagation()
    if (!selectMode) setSelectMode(true)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }

  function buildJobContextActions(): ContextMenuAction[] {
    const rowId = contextRowId
    if (rowId === null) return []
    const targetIds = selectedIds.size > 0 ? Array.from(selectedIds) : [rowId]
    const n = targetIds.length
    const isBulk = n > 1
    return [
      {
        label: 'Open job',
        icon: ExternalLink,
        disabled: isBulk,
        hint: isBulk ? 'Disabled — open one job at a time' : undefined,
        onClick: () => {
          // Use window.open(_self) to navigate; <Link> isn't accessible here.
          window.location.href = `/scrape/${rowId}`
        },
        separatorAfter: true,
      },
      {
        label: isBulk ? `Re-run ${n} jobs` : 'Re-run job',
        icon: RotateCcw,
        disabled: !isAdmin,
        hint: !isAdmin
          ? 'Admin only — bulk re-run creates fresh queue rows'
          : 'Clones the source jobs into the queue, workers pick them up in ~5s',
        onClick: () =>
          startAction(async () => {
            const fd = new FormData()
            for (const id of targetIds) fd.append('job_ids', id)
            const result = await bulkRerunScrapeJobs(null, fd)
            setContextToast(
              result?.status === 'ok'
                ? { ok: true, text: result.message }
                : { ok: false, text: result?.error ?? 'Unknown error.' },
            )
            if (result?.status === 'ok') setSelectedIds(new Set())
          }),
      },
      {
        label: isBulk
          ? `Push all leads from ${n} jobs to Not Relevant`
          : 'Push all leads to Not Relevant',
        icon: Send,
        hint: 'Pushes every lead from the selected jobs to Monday’s Not Relevant board (status=Not relevant, owner=you) and marks them not-relevant locally. Skips leads already on that board. Cap: 500 leads per click.',
        onClick: () =>
          startAction(async () => {
            const fd = new FormData()
            for (const id of targetIds) fd.append('job_ids', id)
            const result = await bulkPushJobLeadsToNotRelevant(null, fd)
            setContextToast(
              result?.status === 'ok'
                ? { ok: true, text: result.message }
                : { ok: false, text: result?.error ?? 'Unknown error.' },
            )
            if (result?.status === 'ok') setSelectedIds(new Set())
          }),
        separatorAfter: true,
      },
      {
        label: isBulk ? `Delete ${n} jobs` : 'Delete job',
        icon: Trash2,
        destructive: true,
        disabled: !isAdmin,
        hint: !isAdmin
          ? 'Admin only — destructive: drops leads, screenshots, s-tags'
          : 'Wipes the selected jobs AND every lead / screenshot / s-tag they produced',
        onClick: () =>
          startAction(async () => {
            const ok = window.confirm(
              `Delete ${n} job${n === 1 ? '' : 's'} permanently?\n\nThis also deletes every lead, screenshot, and s-tag row produced by them. Cannot be undone.`,
            )
            if (!ok) return
            const fd = new FormData()
            for (const id of targetIds) fd.append('job_ids', id)
            const result = await bulkDeleteScrapeJobs(null, fd)
            setContextToast(
              result?.status === 'ok'
                ? { ok: true, text: result.message }
                : { ok: false, text: result?.error ?? 'Unknown error.' },
            )
            if (result?.status === 'ok') setSelectedIds(new Set())
          }),
      },
    ]
  }
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
              <Th>
                <span title="Reviewed — tick once an operator has checked this scrape">✓</span>
              </Th>
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
                  onMouseDownCapture={e => {
                    if (e.button !== 0) return
                    if (isInteractiveTarget(e.target)) return
                    // Only swallow the mousedown when Alt+Click is
                    // about to toggle selection — selection-state
                    // plain clicks flow through to the row link.
                    if (!e.altKey) return
                    e.preventDefault()
                  }}
                  onClickCapture={e => {
                    // Same bailout — let the kebab + any inline
                    // button/select handle its own click.
                    if (isInteractiveTarget(e.target)) return
                    // Alt+Left-Click → toggle selection.
                    if (e.altKey) {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!selectMode) setSelectMode(true)
                      setSelectedIds(prev => {
                        const next = new Set(prev)
                        if (next.has(job.id)) next.delete(job.id)
                        else next.add(job.id)
                        return next
                      })
                      return
                    }
                    // Plain click on the row body — selection
                    // survives so operators can navigate to the
                    // bulk-actions bar without losing what they
                    // picked. Exit selection via the toolbar toggle,
                    // un-ticking every checkbox, or pressing Esc.
                  }}
                  onContextMenu={e => onJobContextMenu(e, job.id)}
                  className={[
                    'group border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]',
                    selectMode && isSelected ? 'bg-[color:var(--color-accent)]/10' : '',
                  ].join(' ')}
                >
                  {selectMode && (
                    <td
                      className="w-8 px-2 py-1 align-middle"
                      onClick={e => onJobCheckboxClick(e, job.id)}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select job ${job.keyword}`}
                        checked={isSelected}
                        onChange={() => {/* handled by onClick */}}
                        onClick={e => onJobCheckboxClick(e, job.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--color-accent)]"
                      />
                    </td>
                  )}
                  <td className="w-8 px-1 py-1 align-middle">
                    <JobActionsButton job={job} />
                  </td>
                  <td className="w-8 px-1 py-1 text-center align-middle">
                    <ReviewedCheckbox job={job} />
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
                    <OutcomeMarker job={job} />
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
                  <PipelineBadges
                    status={job.status}
                    enrichment={job.enrichment}
                    engine={job.search_engine}
                    kick={job.kick}
                    social={job.social}
                  />
                </LinkTd>
                <LinkTd href={href}>{job.batch_id ?? '—'}</LinkTd>
                <LinkTd
                  href={href}
                  className={['max-w-[280px] truncate', errorTone(job)].join(' ')}
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

      {/* Infinite-scroll sentinel + status row. Only rendered when
       *  pageInfo is supplied AND size > 0 (size === 0 is the "All"
       *  sentinel — server already returned everything). The status
       *  row sits below the table so the operator never wonders why
       *  the list stopped growing. */}
      {scrollEnabled && (
        <>
          <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
          <div className="flex items-center justify-center py-3 text-[11px] text-[color:var(--color-text-secondary)]">
            {extraLoading ? (
              <span>Loading more…</span>
            ) : extraError ? (
              <span className="rounded-md bg-red-50 px-2 py-1 text-red-800">
                Failed to load more: {extraError}{' '}
                <button
                  type="button"
                  onClick={loadMore}
                  className="ml-2 underline underline-offset-2"
                >
                  Retry
                </button>
              </span>
            ) : hasMore ? (
              <span>
                Scroll to load more · {accumulatedCount.toLocaleString()} of{' '}
                {pageInfo!.total.toLocaleString()}
              </span>
            ) : accumulatedCount > 0 ? (
              <span>
                All {accumulatedCount.toLocaleString()}{' '}
                {accumulatedCount === 1 ? 'job' : 'jobs'} loaded.
              </span>
            ) : null}
          </div>
        </>
      )}

      <RowContextMenu
        cursor={contextCursor}
        actions={buildJobContextActions()}
        onClose={() => {
          setContextCursor(null)
          setContextRowId(null)
        }}
      />

      {(actionPending || contextToast) && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50">
          <div
            className={[
              'rounded-md px-3 py-2 text-[12px] shadow-lg',
              actionPending
                ? 'bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] border border-[color:var(--color-border)]'
                : contextToast?.ok
                  ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                  : 'bg-red-100 text-red-800 border border-red-300',
            ].join(' ')}
          >
            {actionPending ? 'Working…' : contextToast?.text}
          </div>
        </div>
      )}
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
              <span className="pt-0.5">
                <ReviewedCheckbox job={job} />
              </span>
              <p className="truncate pt-0.5 text-[13px] font-medium text-[color:var(--color-text-primary)]">
                {job.keyword}
              </p>
            </div>
            <span className="inline-flex items-center gap-1">
              <StatusBadge job={job} />
              <OutcomeMarker job={job} />
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
              <PipelineBadges
                status={job.status}
                enrichment={job.enrichment}
                engine={job.search_engine}
                kick={job.kick}
                social={job.social}
              />
            </div>
          )}
          {job.error_message && (
            <p className={['mt-1.5 text-[11px]', errorTone(job)].join(' ')} title={job.error_message}>
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
