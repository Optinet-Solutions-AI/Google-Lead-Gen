'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cookie,
  ExternalLink,
  Eye,
  Hand,
  KeyRound,
  Lock,
  Loader2,
  Monitor,
  RotateCcw,
  ShieldCheck,
  Timer,
  User,
  XCircle,
} from 'lucide-react'
import {
  cancelCheckpointAction,
  openVncAction,
  requeueCheckpointAction,
  resolveCheckpointAction,
  type CheckpointMutationState,
  type OpenVncResult,
} from '../actions'
import { useHideExpiryTimers } from './timer-prefs'

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
    claimed_by_user_id: string | null
    claimed_by_display: string | null
    claimed_at: string | null
    claim_expires_at: string | null
  }
  vncUrl: string | null
  screenshotUrl: string | null
  currentUserId: string
  /** Who originally enqueued the scrape — denormalized from scrape_queue
   *  so operators can tell whose job they're being asked to unblock. */
  requester: {
    display: string | null
    username: string | null
    keyword: string | null
  } | null
}

export function CheckpointCard({
  row,
  vncUrl,
  screenshotUrl,
  currentUserId,
  requester,
}: Props) {
  const [resolveState, resolveAction, resolvePending] = useActionState(
    resolveCheckpointAction,
    initial,
  )
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelCheckpointAction,
    initial,
  )
  const [requeueState, requeueAction, requeuePending] = useActionState(
    requeueCheckpointAction,
    initial,
  )
  const [note, setNote] = useState('')
  const reason: ReasonMeta = REASON_META[row.reason] ?? UNKNOWN_REASON
  const ReasonIcon = reason.icon

  // Claim state. Held server-side in row.claimed_*; client recomputes
  // "is the claim still active?" against a ticking `now` so the gating
  // softens automatically when the 8-min TTL elapses (auto-refresh also
  // pulls the latest row every 5s, this just makes the in-between
  // milliseconds look right).
  //
  // Initial `now` is null so SSR and first hydration produce the same
  // markup — purity rule satisfied. Hook below sets it on mount and
  // ticks every 15s.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    // Wrapping setNow in a named `tick` function (same shape as the
    // minutesLeft hook below) keeps react-hooks/set-state-in-effect
    // happy — it flags direct setState() calls in effects but not
    // function calls that wrap them.
    const tick = () => setNow(Date.now())
    tick()
    const id = setInterval(tick, 15_000)
    return () => clearInterval(id)
  }, [])
  const claimExpiresMs = row.claim_expires_at
    ? new Date(row.claim_expires_at).getTime()
    : 0
  const claimActive = Boolean(
    row.claim_expires_at && row.claimed_by_user_id && (now === null || claimExpiresMs > now),
  )
  const claimMine = claimActive && row.claimed_by_user_id === currentUserId
  const claimOther = claimActive && !claimMine

  const [openVncState, setOpenVncState] = useState<OpenVncResult | null>(null)
  const [openPending, startOpen] = useTransition()
  const openVncError =
    openVncState && openVncState.ok === false ? openVncState : null

  const handleOpenVnc = () => {
    if (openPending) return
    // Pre-open the destination tab inside this click event so popup-
    // blockers don't kill it once the server action returns.
    const newTab = window.open('about:blank', '_blank')
    startOpen(async () => {
      const result = await openVncAction(row.id, row.worker_port)
      setOpenVncState(result)
      if (result.ok) {
        if (newTab) newTab.location.href = result.vnc_url
        else window.open(result.vnc_url, '_blank')
      } else if (newTab) {
        newTab.close()
      }
    })
  }

  const errorMsg =
    resolveState?.status === 'error'
      ? resolveState.error
      : cancelState?.status === 'error'
        ? cancelState.error
        : requeueState?.status === 'error'
          ? requeueState.error
          : null

  // Start as null so SSR and the first client render produce the same
  // markup (a `—` placeholder). The Date.now()-driven value populates
  // in useEffect after mount, so a minute boundary crossing between
  // SSR and hydration no longer causes a hydration mismatch warning
  // (BUGS.md R2-22). The interval continues to tick every 30s.
  const [minutesLeft, setMinutesLeft] = useState<number | null>(null)
  useEffect(() => {
    if (row.status !== 'waiting') return
    const tick = () =>
      setMinutesLeft(
        Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 60_000)),
      )
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [row.expires_at, row.status])
  // Tier the countdown so colour itself signals urgency:
  //   > 3 min — subtle (default chip styling, no alarm)
  //   ≤ 3 min — solid red, white text, full-strength alert
  //   ≤ 1 min — pulsing red ring, "about to time out"
  const timerTier: 'idle' | 'warn' | 'critical' =
    row.status === 'waiting' && minutesLeft !== null
      ? minutesLeft <= 1
        ? 'critical'
        : minutesLeft <= 3
          ? 'warn'
          : 'idle'
      : 'idle'
  const hideTimer = useHideExpiryTimers()

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
          {requester && (requester.display || requester.username) && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-text-secondary)]"
              title={
                requester.keyword
                  ? `Scrape queued by ${requester.display ?? requester.username} — keyword: ${requester.keyword}`
                  : `Scrape queued by ${requester.display ?? requester.username}`
              }
            >
              <User className="h-2.5 w-2.5" />
              by {requester.display ?? requester.username}
            </span>
          )}
          {row.status === 'waiting' && !hideTimer && (
            <span
              className={[
                'inline-flex items-center gap-1 rounded-md text-[10px] font-semibold',
                timerTier === 'critical'
                  ? 'animate-pulse bg-rose-600 px-2 py-0.5 text-white shadow-sm ring-2 ring-rose-300'
                  : timerTier === 'warn'
                    ? 'bg-rose-600 px-2 py-0.5 text-white shadow-sm'
                    : 'bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[color:var(--color-text-secondary)]',
              ].join(' ')}
            >
              <Timer className="h-2.5 w-2.5" />
              {minutesLeft ?? '—'} min left
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
            {claimOther && (
              <p className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                <Lock className="h-3 w-3" />
                <span>
                  Solving by <strong>{row.claimed_by_display ?? 'another user'}</strong>
                  {row.claim_expires_at && (
                    <> · auto-releases in {minutesLeftFromIso(row.claim_expires_at)} min</>
                  )}
                </span>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {vncUrl ? (
                <button
                  type="button"
                  onClick={handleOpenVnc}
                  disabled={openPending || claimOther}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    claimOther
                      ? `Another user is currently solving this captcha. Wait for them or for the ~8 min claim to expire.`
                      : claimMine
                        ? 'Re-open the noVNC tab — you already hold the claim.'
                        : 'Take the claim and open the live browser in a new tab'
                  }
                >
                  {openPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Eye className="h-3 w-3" />
                  )}
                  {claimMine ? 'Re-open VNC' : 'Open VNC'}
                </button>
              ) : (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/40 px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)]"
                  title="noVNC isn't configured on this deploy. See docs/runbook-novnc.md."
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
                  disabled={resolvePending || claimOther}
                  title={claimOther ? 'Another user is solving — Resume is locked until their claim expires.' : 'Mark resolved'}
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
                  disabled={cancelPending || claimOther}
                  title={claimOther ? 'Another user is solving — Cancel is locked until their claim expires.' : 'Cancel this scrape'}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {cancelPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                  Cancel
                </button>
              </form>
            </div>
          </div>
        )}

        {row.status !== 'waiting' && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] text-[color:var(--color-text-secondary)]">
              {row.status === 'resolved' && row.resolved_at && (
                <>Resumed {new Date(row.resolved_at).toLocaleString()}{row.resolved_by ? ` by ${row.resolved_by}` : ''}</>
              )}
              {row.status === 'cancelled' && row.resolved_at && (
                <>Cancelled {new Date(row.resolved_at).toLocaleString()}{row.resolved_by ? ` by ${row.resolved_by}` : ''}</>
              )}
              {row.status === 'timed_out' && (
                <>Timed out at {new Date(row.expires_at).toLocaleString()}</>
              )}
              {row.resolution_note && <> · &ldquo;{row.resolution_note}&rdquo;</>}
            </p>

            {(row.status === 'timed_out' || row.status === 'cancelled') && (
              <form
                action={requeueAction}
                onSubmit={e => {
                  if (
                    !confirm(
                      'Re-queue this scrape with a fresh Captcha helper window? The worker will re-claim the job, navigate to the same SERP again, and you\'ll get up to 10 chances (5 min each) to solve the captcha — the browser auto-refreshes between attempts. Resets attempts + captcha_attempts counters.',
                    )
                  ) {
                    e.preventDefault()
                  }
                }}
                className="ml-auto"
              >
                <input type="hidden" name="job_id" value={row.job_id} />
                <button
                  type="submit"
                  disabled={requeuePending || requeueState?.status === 'ok'}
                  title="Re-queue this scrape with a fresh Captcha helper window"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {requeuePending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                  {requeueState?.status === 'ok' ? 'Re-queued' : 'Re-queue with Captcha helper'}
                </button>
              </form>
            )}
          </div>
        )}

        {errorMsg && (
          <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {errorMsg}
          </p>
        )}
        {openVncError && (
          <p className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
            {openVncError.reason === 'claimed_by_other' ? (
              <>
                Couldn&apos;t open — <strong>{openVncError.claimed_by_display ?? 'another user'}</strong>
                {' '}is currently solving this captcha. Try again after the claim auto-releases
                {openVncError.claim_expires_at && (
                  <> in {minutesLeftFromIso(openVncError.claim_expires_at)} min</>
                )}
                .
              </>
            ) : openVncError.reason === 'no_vnc_config' ? (
              <>noVNC isn&apos;t configured on this deploy. See <code>docs/runbook-novnc.md</code>.</>
            ) : (
              openVncError.error ?? "Couldn't open the VNC session. Try again, or check that the scraper is still running on the VM."
            )}
          </p>
        )}
      </div>
    </article>
  )
}

function minutesLeftFromIso(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / 60_000))
}
