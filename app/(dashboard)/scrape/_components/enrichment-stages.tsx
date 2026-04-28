'use client'

import { useState, useActionState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Database,
  Loader2,
  Mail,
  Play,
  Search,
  Tag,
  Users,
} from 'lucide-react'
import {
  checkMondayDuplicates,
  runAffiliateDetection,
  runContactExtraction,
  runRoosterCheck,
  runStagDuplicateCheck,
  runStagExtraction,
  type CheckMondayState,
  type StageRunState,
} from '../actions'
import type { StageStatus, StageSummary } from '../_lib/queries'

const initialMonday: CheckMondayState = null
const initialStage: StageRunState = null

type StageKey = keyof StageSummary

function summaryLabel(key: StageKey, s: StageStatus): string {
  if (s.total === 0) return 'not yet'
  const parts: string[] = [`${s.total} processed`]
  switch (key) {
    case 'monday':
      parts.push(s.positive === 0 ? 'no matches' : `${s.positive} matched`)
      break
    case 'affiliate':
      parts.push(s.positive === 0 ? 'no affiliates' : `${s.positive} affiliates`)
      if (s.errored > 0) parts.push(`${s.errored} errored`)
      break
    case 'rooster':
      parts.push(s.positive === 0 ? 'no partners' : `${s.positive} Rooster partners`)
      break
    case 'contact':
      parts.push(s.positive === 0 ? 'no contacts' : `${s.positive} with contacts`)
      break
    case 'stag':
      parts.push(s.positive === 0 ? 'no s-tags' : `${s.positive} with s-tags`)
      break
    case 'stagCheck':
      parts.push(s.positive === 0 ? 'none on Monday' : `${s.positive} on Monday`)
      break
  }
  return parts.join(' · ')
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diff = Date.now() - then
  const mins = Math.round(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

type StageRowProps = {
  index: number
  stageKey: StageKey
  title: string
  icon: React.ReactNode
  status: StageStatus
  action: (formData: FormData) => void
  pending: boolean
  message: string | null
  error: string | null
  jobId: string
}

function StageRow({
  index,
  stageKey,
  title,
  icon,
  status,
  action,
  pending,
  message,
  error,
  jobId,
}: StageRowProps) {
  const done = status.total > 0
  // In-flight state — block the play button while jobs are queued/running
  // so users don't double-trigger the same stage. Workers process the
  // queue in the background; the dashboard auto-refreshes counts.
  const inflightPending = status.inflight_pending ?? 0
  const inflightRunning = status.inflight_running ?? 0
  const hasInflight = inflightPending + inflightRunning > 0
  const buttonDisabled = pending || hasInflight

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={[
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
            hasInflight
              ? 'bg-amber-100 text-amber-700'
              : done
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
          ].join(' ')}
          title={hasInflight ? 'Working' : done ? 'Done' : 'Not run'}
        >
          {hasInflight
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : done
              ? <CheckCircle2 className="h-3 w-3" />
              : <Circle className="h-3 w-3" />}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)]">
          {icon}
          <span className="whitespace-nowrap">{index}. {title}</span>
        </span>
        <span className="text-[11px] text-[color:var(--color-text-secondary)]">
          {hasInflight ? (
            <span className="font-medium text-amber-700">
              {inflightRunning > 0 && `${inflightRunning} running`}
              {inflightRunning > 0 && inflightPending > 0 && ' · '}
              {inflightPending > 0 && `${inflightPending} pending`}
            </span>
          ) : (
            <>
              {summaryLabel(stageKey, status)}
              {status.lastRunAt && <> · {relativeTime(status.lastRunAt)}</>}
            </>
          )}
        </span>

        <form action={action} className="ml-auto">
          <input type="hidden" name="job_id" value={jobId} />
          <button
            type="submit"
            disabled={buttonDisabled}
            aria-label={hasInflight ? `${title} already running` : `Run ${title}`}
            title={hasInflight ? `${title} already running — wait for it to finish` : `Run ${title}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {hasInflight
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Play className={['h-3 w-3', pending ? 'animate-pulse' : ''].join(' ')} />}
          </button>
        </form>
      </div>
      {(message || error) && (
        <div className="text-[11px]">
          {message && (
            <span className="rounded-md bg-green-50 px-2 py-1 text-green-700">{message}</span>
          )}
          {error && (
            <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">{error}</span>
          )}
        </div>
      )}
    </div>
  )
}

type StagesProps = {
  jobId: string
  summary: StageSummary
}

export function EnrichmentStages({ jobId, summary }: StagesProps) {
  const [open, setOpen] = useState(false)

  // Each stage hosts its own useActionState — React will hydrate these idle
  // even while the containing details element is closed.
  const [mondayState, mondayAction, mondayPending] = useActionState(
    checkMondayDuplicates,
    initialMonday,
  )
  const [affState, affAction, affPending] = useActionState(runAffiliateDetection, initialStage)
  const [roosterState, roosterAction, roosterPending] = useActionState(runRoosterCheck, initialStage)
  const [contactState, contactAction, contactPending] = useActionState(
    runContactExtraction,
    initialStage,
  )
  const [stagState, stagAction, stagPending] = useActionState(runStagExtraction, initialStage)
  const [stagCheckState, stagCheckAction, stagCheckPending] = useActionState(
    runStagDuplicateCheck,
    initialStage,
  )

  const doneCount = (
    [summary.monday, summary.affiliate, summary.rooster, summary.contact, summary.stag, summary.stagCheck] as StageStatus[]
  ).filter(s => s.total > 0).length

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[color:var(--color-bg-secondary)]"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Enrichment pipeline
        </span>
        <span className="flex items-center gap-2">
          <span
            className={[
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              doneCount === 6
                ? 'bg-emerald-100 text-emerald-800'
                : doneCount > 0
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
            ].join(' ')}
          >
            {doneCount} of 6 done
          </span>
          <ChevronDown
            className={['h-4 w-4 text-[color:var(--color-text-secondary)] transition-transform', open ? 'rotate-180' : ''].join(' ')}
          />
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-1.5 border-t border-[color:var(--color-border)] p-2">
          <StageRow
            index={1}
            stageKey="monday"
            title="Check Monday duplicates"
            icon={<Database className="h-3 w-3" />}
            status={summary.monday}
            action={mondayAction}
            pending={mondayPending}
            message={mondayState?.status === 'ok' ? mondayState.message : null}
            error={mondayState?.status === 'error' ? mondayState.error : null}
            jobId={jobId}
          />
          <StageRow
            index={2}
            stageKey="affiliate"
            title="Detect affiliates"
            icon={<Search className="h-3 w-3" />}
            status={summary.affiliate}
            action={affAction}
            pending={affPending}
            message={affState?.status === 'ok' ? affState.message : null}
            error={affState?.status === 'error' ? affState.error : null}
            jobId={jobId}
          />
          <StageRow
            index={3}
            stageKey="rooster"
            title="Check Rooster brands"
            icon={<CheckCircle2 className="h-3 w-3" />}
            status={summary.rooster}
            action={roosterAction}
            pending={roosterPending}
            message={roosterState?.status === 'ok' ? roosterState.message : null}
            error={roosterState?.status === 'error' ? roosterState.error : null}
            jobId={jobId}
          />
          <StageRow
            index={4}
            stageKey="contact"
            title="Extract contacts"
            icon={<Mail className="h-3 w-3" />}
            status={summary.contact}
            action={contactAction}
            pending={contactPending}
            message={contactState?.status === 'ok' ? contactState.message : null}
            error={contactState?.status === 'error' ? contactState.error : null}
            jobId={jobId}
          />
          <StageRow
            index={5}
            stageKey="stag"
            title="Extract s-tags (affiliates)"
            icon={<Tag className="h-3 w-3" />}
            status={summary.stag}
            action={stagAction}
            pending={stagPending}
            message={stagState?.status === 'ok' ? stagState.message : null}
            error={stagState?.status === 'error' ? stagState.error : null}
            jobId={jobId}
          />
          <StageRow
            index={6}
            stageKey="stagCheck"
            title="Verify s-tags on Monday"
            icon={<Users className="h-3 w-3" />}
            status={summary.stagCheck}
            action={stagCheckAction}
            pending={stagCheckPending}
            message={stagCheckState?.status === 'ok' ? stagCheckState.message : null}
            error={stagCheckState?.status === 'error' ? stagCheckState.error : null}
            jobId={jobId}
          />
        </div>
      )}
    </section>
  )
}
