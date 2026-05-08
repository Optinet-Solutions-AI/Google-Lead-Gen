'use client'

import { useActionState, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cookie,
  ExternalLink,
  Eye,
  Hand,
  KeyRound,
  Loader2,
  Monitor,
  ShieldCheck,
  Timer,
  XCircle,
} from 'lucide-react'
import {
  cancelCheckpointAction,
  resolveCheckpointAction,
  type CheckpointMutationState,
} from '../actions'

const initial: CheckpointMutationState = null

type ReasonMeta = {
  label: string
  icon: React.ComponentType<{ className?: string }>
  tone: string
}

const UNKNOWN_REASON: ReasonMeta = {
  label: 'Needs human',
  icon: Hand,
  tone: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
}

const REASON_META: Record<string, ReasonMeta> = {
  captcha: {
    label: 'CAPTCHA',
    icon: ShieldCheck,
    tone: 'bg-amber-100 text-amber-800',
  },
  age_gate: {
    label: 'Age verification',
    icon: AlertTriangle,
    tone: 'bg-rose-100 text-rose-800',
  },
  cookie_banner: {
    label: 'Cookie banner',
    icon: Cookie,
    tone: 'bg-sky-100 text-sky-800',
  },
  google_login_required: {
    label: 'Google login',
    icon: KeyRound,
    tone: 'bg-violet-100 text-violet-800',
  },
  unknown: UNKNOWN_REASON,
}

const STATUS_TONE: Record<string, string> = {
  waiting:    'bg-amber-100 text-amber-800',
  resolved:   'bg-emerald-100 text-emerald-800',
  cancelled:  'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] line-through',
  timed_out:  'bg-rose-100 text-rose-800',
}

type Props = {
  row: {
    id: number
    job_id: string
    worker_id: string
    worker_port: number
    reason: string
    current_url: string | null
    page_title: string | null
    screenshot_path: string | null
    status: 'waiting' | 'resolved' | 'cancelled' | 'timed_out'
    resolution_note: string | null
    resolved_at: string | null
    resolved_by: string | null
    expires_at: string
    created_at: string
    updated_at: string
  }
  vncUrl: string | null
  screenshotUrl: string | null
}

export function CheckpointCard({ row, vncUrl, screenshotUrl }: Props) {
  const [resolveState, resolveAction, resolvePending] = useActionState(
    resolveCheckpointAction,
    initial,
  )
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelCheckpointAction,
    initial,
  )
  const [note, setNote] = useState('')
  const reason: ReasonMeta = REASON_META[row.reason] ?? UNKNOWN_REASON
  const ReasonIcon = reason.icon

  const errorMsg =
    resolveState?.status === 'error'
      ? resolveState.error
      : cancelState?.status === 'error'
        ? cancelState.error
        : null

  // Lazy initialiser keeps the Date.now() call out of the render
  // path; the interval below ticks the value every minute so the
  // "N min left" pill stays honest.
  const [minutesLeft, setMinutesLeft] = useState(() =>
    Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 60_000)),
  )
  useEffect(() => {
    if (row.status !== 'waiting') return
    const tick = () =>
       
      setMinutesLeft(
        Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 60_000)),
      )
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [row.expires_at, row.status])
  const expiryWarn = row.status === 'waiting' && minutesLeft <= 3

  return (
    <article className="flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 md:flex-row">
      {/* Thumbnail of the paused page */}
      <div className="flex w-full shrink-0 items-center justify-center overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] md:h-40 md:w-64">
        {screenshotUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={screenshotUrl}
            alt={`Paused at ${row.current_url ?? 'unknown URL'}`}
            className="max-h-40 w-full object-cover object-top"
            loading="lazy"
          />
        ) : (
          <div className="flex h-40 w-full flex-col items-center justify-center gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
            <Monitor className="h-6 w-6" />
            no thumbnail
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex flex-wrap items-center gap-2">
          <span
            className={[
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              reason.tone,
            ].join(' ')}
          >
            <ReasonIcon className="h-2.5 w-2.5" />
            {reason.label}
          </span>
          <span
            className={[
              'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              STATUS_TONE[row.status] ?? '',
            ].join(' ')}
          >
            {row.status === 'timed_out' ? 'timed out' : row.status}
          </span>
          <span className="text-[11px] text-[color:var(--color-text-secondary)]">
            worker {row.worker_id} · port {row.worker_port}
          </span>
          {row.status === 'waiting' && (
            <span
              className={[
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
                expiryWarn
                  ? 'bg-rose-100 text-rose-800'
                  : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
              ].join(' ')}
            >
              <Timer className="h-2.5 w-2.5" />
              {minutesLeft} min left
            </span>
          )}
        </header>

        <div className="text-[12px] text-[color:var(--color-text-primary)]">
          {row.page_title && (
            <p className="truncate font-semibold" title={row.page_title}>
              {row.page_title}
            </p>
          )}
          {row.current_url && (
            <a
              href={row.current_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-[11px] text-[color:var(--color-accent)] hover:text-[color:var(--color-accent-hover)]"
              title={row.current_url}
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{row.current_url}</span>
            </a>
          )}
        </div>

        {row.status === 'waiting' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {vncUrl ? (
                <a
                  href={vncUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30"
                  title="Open the live browser in a new tab"
                >
                  <Eye className="h-3 w-3" />
                  Open VNC
                </a>
              ) : (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/40 px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)]"
                  title="noVNC not configured — see the runbook"
                >
                  <Eye className="h-3 w-3" />
                  Open VNC (not configured)
                </span>
              )}

              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Optional note (visible in the audit log)…"
                className="min-w-0 flex-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <form action={resolveAction}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="note" value={note} />
                <button
                  type="submit"
                  disabled={resolvePending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {resolvePending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                  Resume
                </button>
              </form>

              <form
                action={cancelAction}
                onSubmit={e => {
                  if (!confirm('Cancel this scrape and free its country lock?')) {
                    e.preventDefault()
                  }
                }}
              >
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="note" value={note} />
                <button
                  type="submit"
                  disabled={cancelPending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
                >
                  {cancelPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                  Cancel
                </button>
              </form>
            </div>
          </div>
        )}

        {row.status !== 'waiting' && (
          <p className="text-[11px] text-[color:var(--color-text-secondary)]">
            {row.status === 'resolved' && row.resolved_at && (
              <>Resumed {new Date(row.resolved_at).toLocaleString()}{row.resolved_by ? ` by ${row.resolved_by}` : ''}</>
            )}
            {row.status === 'cancelled' && row.resolved_at && (
              <>Cancelled {new Date(row.resolved_at).toLocaleString()}{row.resolved_by ? ` by ${row.resolved_by}` : ''}</>
            )}
            {row.status === 'timed_out' && (
              <>Auto-cancelled at {new Date(row.expires_at).toLocaleString()}</>
            )}
            {row.resolution_note && <> · &ldquo;{row.resolution_note}&rdquo;</>}
          </p>
        )}

        {errorMsg && (
          <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {errorMsg}
          </p>
        )}
      </div>
    </article>
  )
}
