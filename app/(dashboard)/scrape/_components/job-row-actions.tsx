'use client'

import { useActionState, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MoreVertical,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import {
  cancelScrapeJob,
  deleteScrapeJob,
  forceCompleteEnrichment,
  pauseEnrichmentForJob,
  pauseScrapeJob,
  rerunScrapeFiltered,
  resetCaptchaRetries,
  resumeEnrichmentForJob,
  resumeScrapeJob,
  type EnqueueState,
  type JobActionState,
} from '../actions'
import type { ScrapeJob } from '../_lib/queries'

const initial: JobActionState = null

export function JobActionsButton({ job }: { job: ScrapeJob }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={e => {
          // Stop the row's wrapping <Link> from firing.
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        aria-label="Job actions"
        title="Manage this job"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-primary)] hover:text-[color:var(--color-text-primary)]"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && <ActionsModal job={job} onClose={() => setOpen(false)} />}
    </>
  )
}

function ActionsModal({ job, onClose }: { job: ScrapeJob; onClose: () => void }) {
  const enrichmentInFlight =
    job.with_enrichment &&
    job.status === 'completed' &&
    job.enrichment_status !== 'complete'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              Manage scrape
            </p>
            <h2
              className="mt-0.5 truncate text-[14px] font-semibold text-[color:var(--color-text-primary)]"
              title={job.keyword}
            >
              {job.keyword}
            </h2>
            <p className="mt-0.5 text-[11px] text-[color:var(--color-text-secondary)]">
              {job.country_code} · {job.pages} page{job.pages === 1 ? '' : 's'} · status{' '}
              <span className="font-medium text-[color:var(--color-text-primary)]">
                {job.status}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-col gap-3 p-4">
          <ScrapeLifecycleSection job={job} />
          {job.status === 'captcha' && <CaptchaResetSection job={job} />}
          {enrichmentInFlight && <EnrichmentLifecycleSection job={job} />}
          <RerunSection job={job} />
          <DangerZone job={job} onDeleted={onClose} />
        </div>
      </div>
    </div>
  )
}

function ScrapeLifecycleSection({ job }: { job: ScrapeJob }) {
  const [pauseState, pauseAction, pausing] = useActionState(pauseScrapeJob, initial)
  const [resumeState, resumeAction, resuming] = useActionState(resumeScrapeJob, initial)
  const message = pauseState ?? resumeState

  if (job.status === 'pending') {
    return (
      <Section title="Scrape">
        <form action={pauseAction}>
          <input type="hidden" name="job_id" value={job.id} />
          <ActionButton
            tone="neutral"
            disabled={pausing}
            icon={pausing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
          >
            Pause — workers will skip until resumed
          </ActionButton>
        </form>
        <FlashMessage state={message} />
      </Section>
    )
  }
  if (job.status === 'paused') {
    return (
      <Section title="Scrape">
        <form action={resumeAction}>
          <input type="hidden" name="job_id" value={job.id} />
          <ActionButton
            tone="primary"
            disabled={resuming}
            icon={resuming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          >
            Resume — flip back to pending
          </ActionButton>
        </form>
        <FlashMessage state={message} />
      </Section>
    )
  }
  if (job.status === 'running') {
    return (
      <Section title="Scrape">
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          Worker is actively scraping. Pausing isn&apos;t available mid-run — wait for it
          to finish, then cancel or delete if needed.
        </p>
      </Section>
    )
  }
  return null
}

function EnrichmentLifecycleSection({ job }: { job: ScrapeJob }) {
  const [pauseState, pauseAction, pausing] = useActionState(pauseEnrichmentForJob, initial)
  const [resumeState, resumeAction, resuming] = useActionState(resumeEnrichmentForJob, initial)
  const [forceState, forceAction, forcing] = useActionState(forceCompleteEnrichment, initial)

  return (
    <Section title="Enrichment">
      <p className="text-[11px] text-[color:var(--color-text-secondary)]">
        Pausing flips every <em>pending</em> enrichment row to paused; rows already running
        will finish naturally. Use <em>Force complete</em> if the chain is stuck on
        permanently-failed domains.
      </p>
      <div className="flex flex-wrap gap-2">
        <form action={pauseAction}>
          <input type="hidden" name="job_id" value={job.id} />
          <ActionButton
            tone="neutral"
            disabled={pausing}
            icon={pausing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
          >
            Pause enrichment
          </ActionButton>
        </form>
        <form action={resumeAction}>
          <input type="hidden" name="job_id" value={job.id} />
          <ActionButton
            tone="primary"
            disabled={resuming}
            icon={resuming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          >
            Resume enrichment
          </ActionButton>
        </form>
        <form action={forceAction}>
          <input type="hidden" name="job_id" value={job.id} />
          <button
            type="submit"
            disabled={forcing}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
            title="Skip waiting on stalled rows and mark enrichment complete"
          >
            {forcing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
            Force complete
          </button>
        </form>
      </div>
      <FlashMessage state={pauseState ?? resumeState ?? forceState} />
    </Section>
  )
}

function CaptchaResetSection({ job }: { job: ScrapeJob }) {
  const [state, action, pending] = useActionState(resetCaptchaRetries, initial)
  return (
    <Section title="Captcha">
      <p className="text-[11px] text-[color:var(--color-text-secondary)]">
        This job hit the captcha auto-retry cap ({job.captcha_attempts ?? 0}{' '}
        attempts). Reset to retry up to 10 more times — each session uses a
        fresh proxy IP so a different result is likely.
      </p>
      <form action={action}>
        <input type="hidden" name="job_id" value={job.id} />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
          title="Reset captcha counter and re-queue for another 10 retries"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
          Try again — reset captcha counter
        </button>
      </form>
      <FlashMessage state={state} />
    </Section>
  )
}

function RerunSection({ job }: { job: ScrapeJob }) {
  const initialEnq: EnqueueState = null
  const [state, action, pending] = useActionState(rerunScrapeFiltered, initialEnq)

  // Re-running mid-flight would race with the worker, so only offer
  // it once the original job is in a terminal state.
  const allowed = ['completed', 'failed', 'captcha', 'cancelled'] as const
  if (!(allowed as readonly string[]).includes(job.status)) return null

  return (
    <Section title="Re-run">
      <p className="text-[11px] text-[color:var(--color-text-secondary)]">
        Queue a fresh scrape for the same keyword/country/pages but only
        keep one result type. Useful when the original PPC capture failed
        — no need to re-pay for the organic side that already worked.
      </p>
      <div className="flex flex-wrap gap-2">
        <form action={action}>
          <input type="hidden" name="job_id" value={job.id} />
          <input type="hidden" name="result_type_filter" value="both" />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-40"
            title="Queue a new scrape and keep all result types (PPC + organic)"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Re-run — both
          </button>
        </form>
        <form action={action}>
          <input type="hidden" name="job_id" value={job.id} />
          <input type="hidden" name="result_type_filter" value="PPC" />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
            title="Queue a new scrape that only keeps PPC ads"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Re-run — PPC only
          </button>
        </form>
        <form action={action}>
          <input type="hidden" name="job_id" value={job.id} />
          <input type="hidden" name="result_type_filter" value="Organic" />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
            title="Queue a new scrape that only keeps organic results"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Re-run — Organic only
          </button>
        </form>
      </div>
      {state && (
        <p
          className={[
            'rounded-md px-2 py-1 text-[11px]',
            state.status === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800',
          ].join(' ')}
        >
          {state.status === 'ok' ? state.message : state.error}
        </p>
      )}
    </Section>
  )
}

function DangerZone({ job, onDeleted }: { job: ScrapeJob; onDeleted: () => void }) {
  const isCancellable =
    job.status !== 'completed' && job.status !== 'cancelled' && job.status !== 'running'
  return (
    <section className="rounded-md border border-red-200 bg-red-50/40 p-3">
      <div className="flex items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 text-red-700" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-red-800">
          Danger zone
        </h3>
      </div>
      <p className="mt-1 text-[11px] text-red-900/80">
        Type the exact keyword <span className="font-mono font-semibold">{job.keyword}</span>{' '}
        below to enable the destructive actions.
      </p>
      <DestructivePanel job={job} isCancellable={isCancellable} onDeleted={onDeleted} />
    </section>
  )
}

function DestructivePanel({
  job,
  isCancellable,
  onDeleted,
}: {
  job: ScrapeJob
  isCancellable: boolean
  onDeleted: () => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const matches = confirmation === job.keyword

  const [cancelState, cancelAction, cancelling] = useActionState(cancelScrapeJob, initial)
  const [deleteState, deleteAction, deleting] = useActionState(deleteScrapeJob, initial)

  // Close the modal on a successful delete (the row no longer exists).
  if (deleteState?.status === 'ok') {
    queueMicrotask(onDeleted)
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <input
        type="text"
        value={confirmation}
        onChange={e => setConfirmation(e.target.value)}
        placeholder="Retype the keyword to confirm…"
        className="w-full rounded-md border border-red-300 bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-red-500 focus:outline-none"
      />

      <div className="flex flex-wrap gap-2">
        {isCancellable && (
          <form action={cancelAction}>
            <input type="hidden" name="job_id" value={job.id} />
            <input type="hidden" name="confirmation_text" value={confirmation} />
            <button
              type="submit"
              disabled={!matches || cancelling}
              className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              Cancel job
            </button>
          </form>
        )}

        <form action={deleteAction}>
          <input type="hidden" name="job_id" value={job.id} />
          <input type="hidden" name="confirmation_text" value={confirmation} />
          <button
            type="submit"
            disabled={!matches || deleting}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-100 px-2.5 py-1 text-[11px] font-semibold text-red-900 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Delete job + all data
          </button>
        </form>
      </div>

      <FlashMessage state={cancelState ?? deleteState} tone="danger" />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {title}
      </h3>
      {children}
    </section>
  )
}

function ActionButton({
  children,
  icon,
  tone,
  disabled,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  tone: 'neutral' | 'primary'
  disabled?: boolean
}) {
  const styles =
    tone === 'primary'
      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30'
      : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]'
  return (
    <button
      type="submit"
      disabled={disabled}
      className={[
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40',
        styles,
      ].join(' ')}
    >
      {icon}
      {children}
    </button>
  )
}

function FlashMessage({
  state,
  tone = 'neutral',
}: {
  state: JobActionState
  tone?: 'neutral' | 'danger'
}) {
  if (!state) return null
  const okStyle =
    tone === 'danger'
      ? 'bg-red-100 text-red-900'
      : 'bg-green-100 text-green-800'
  return (
    <p
      className={[
        'rounded-md px-2 py-1 text-[11px]',
        state.status === 'ok' ? okStyle : 'bg-red-100 text-red-800',
      ].join(' ')}
    >
      {state.status === 'ok' ? state.message : state.error}
    </p>
  )
}
