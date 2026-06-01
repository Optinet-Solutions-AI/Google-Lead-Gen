'use client'

import { useActionState } from 'react'
import { CheckCircle2, Loader2, Play, Tv } from 'lucide-react'
import { runKickProfileEnrichment, type StageRunState } from '../actions'
import type { KickStreamerSummary } from '../_lib/queries'

const initialState: StageRunState = null

/**
 * Kick Phase-2 panel. Shown only for search_engine='kick' jobs (their
 * leads table is empty — streamers live in kick_streamers). Surfaces the
 * Phase-1 discovery counts and the operator-triggered ▶ that enqueues a
 * Phase-2 browser-enrichment job (runKickProfileEnrichment → a new
 * scrape_queue row the GoLogin workers claim).
 */
export function KickStreamersPanel({
  jobId,
  summary,
}: {
  jobId: string
  summary: KickStreamerSummary
}) {
  const [state, formAction, pending] = useActionState(runKickProfileEnrichment, initialState)

  const inflight = summary.inflight
  const nothingToDo = summary.pending === 0 && summary.discovered > 0
  const noStreamers = summary.discovered === 0
  const buttonDisabled = pending || inflight || nothingToDo || noStreamers

  const message = state?.status === 'ok' ? state.message : null
  const error = state?.status === 'error' ? state.error : null

  const buttonTitle = noStreamers
    ? 'No streamers discovered yet — run the Kick scrape first'
    : inflight
      ? 'Profile enrichment already running — wait for it to finish'
      : nothingToDo
        ? 'Every discovered streamer already enriched'
        : 'Enrich the top streamer profiles (socials, follower count, promo & pinned links)'

  return (
    <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          <Tv className="h-4 w-4" />
          Kick streamer profiles
        </span>
        <span
          className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
          title="Operator-triggered — click ▶ to scrape kick.com/{slug} for each streamer"
        >
          manual
        </span>

        <span className="text-[11px] text-[color:var(--color-text-secondary)]">
          {noStreamers ? (
            'No streamers discovered'
          ) : (
            <>
              {summary.discovered} discovered ·{' '}
              <span className="font-medium text-emerald-700">{summary.enriched} enriched</span>
              {summary.pending > 0 && <> · {summary.pending} pending</>}
              {summary.failed > 0 && (
                <> · <span className="text-red-600">{summary.failed} failed</span></>
              )}
            </>
          )}
        </span>

        <div className="ml-auto">
          <form action={formAction}>
            <input type="hidden" name="job_id" value={jobId} />
            <button
              type="submit"
              disabled={buttonDisabled}
              aria-label="Enrich Kick streamer profiles"
              title={buttonTitle}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {inflight ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Running
                </>
              ) : nothingToDo ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Done
                </>
              ) : (
                <>
                  <Play className={['h-3 w-3', pending ? 'animate-pulse' : ''].join(' ')} /> Enrich profiles
                </>
              )}
            </button>
          </form>
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-[color:var(--color-text-secondary)]">
        Opens the top streamers (by live viewers) in a real browser to backfill social handles,
        follower count, and casino promo / pinned-chat links — surfaces the Kick API doesn&apos;t expose.
        Re-running only re-attempts streamers not yet scraped.
      </p>

      {(message || error) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
          {message && (
            <span className="rounded-md bg-green-50 px-2 py-1 text-green-700">{message}</span>
          )}
          {error && <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">{error}</span>}
        </div>
      )}
    </section>
  )
}
