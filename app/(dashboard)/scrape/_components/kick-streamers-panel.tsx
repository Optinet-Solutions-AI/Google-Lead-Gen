'use client'

import { useActionState } from 'react'
import { CheckCircle2, Loader2, Play, Sparkles, Tv } from 'lucide-react'
import {
  runKickProfileEnrichment,
  runKickStreamerAnalysis,
  type StageRunState,
} from '../actions'
import type { KickStreamerSummary } from '../_lib/queries'

const initialState: StageRunState = null

/**
 * Kick streamer panel (Phases 2 + 3). Shown only for search_engine='kick'
 * jobs. Two operator-triggered ▶ actions:
 *   - Enrich profiles  → Phase 2 browser scrape (runKickProfileEnrichment,
 *     enqueues a scrape_queue job the GoLogin workers claim)
 *   - Score & resolve  → Phase 3 affiliate scoring + shortener resolution
 *     (runKickStreamerAnalysis, runs inline — pure data + light HTTP)
 */
export function KickStreamersPanel({
  jobId,
  summary,
}: {
  jobId: string
  summary: KickStreamerSummary
}) {
  const [enrichState, enrichAction, enrichPending] = useActionState(
    runKickProfileEnrichment,
    initialState,
  )
  const [scoreState, scoreAction, scorePending] = useActionState(
    runKickStreamerAnalysis,
    initialState,
  )

  const inflight = summary.inflight
  const nothingToEnrich = summary.pending === 0 && summary.discovered > 0
  const noStreamers = summary.discovered === 0
  const enrichDisabled = enrichPending || inflight || nothingToEnrich || noStreamers
  const scoreDisabled = scorePending || noStreamers

  // Big jobs enrich in time-budgeted batches, so streamers can remain
  // pending after a run — surface that the operator should re-run.
  const enrichedSome = summary.enriched > 0
  const moreToEnrich = summary.pending > 0 && enrichedSome
  // Streamers that have never been scored (or were scored before more got
  // enriched) — nudge the operator to (re-)run scoring.
  const unscored = Math.max(0, summary.discovered - summary.scored)
  const scoreNeeded = !noStreamers && !inflight && (unscored > 0 || (enrichedSome && summary.scored === 0))

  const messages = [
    enrichState?.status === 'ok' ? enrichState.message : null,
    scoreState?.status === 'ok' ? scoreState.message : null,
  ].filter(Boolean) as string[]
  const errors = [
    enrichState?.status === 'error' ? enrichState.error : null,
    scoreState?.status === 'error' ? scoreState.error : null,
  ].filter(Boolean) as string[]

  const enrichTitle = noStreamers
    ? 'No streamers discovered yet — run the Kick scrape first'
    : inflight
      ? 'Profile enrichment already running — wait for it to finish'
      : nothingToEnrich
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
              {summary.scored > 0 && (
                <> · <span className="font-medium text-blue-700">{summary.likelyAffiliates} likely affiliate{summary.likelyAffiliates === 1 ? '' : 's'}</span></>
              )}
            </>
          )}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <form action={enrichAction}>
            <input type="hidden" name="job_id" value={jobId} />
            <button
              type="submit"
              disabled={enrichDisabled}
              aria-label="Enrich Kick streamer profiles"
              title={enrichTitle}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {inflight ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Running
                </>
              ) : nothingToEnrich ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Enriched
                </>
              ) : (
                <>
                  <Play className={['h-3 w-3', enrichPending ? 'animate-pulse' : ''].join(' ')} />
                  {moreToEnrich ? `Enrich ${summary.pending} more` : 'Enrich profiles'}
                </>
              )}
            </button>
          </form>

          <form action={scoreAction}>
            <input type="hidden" name="job_id" value={jobId} />
            <button
              type="submit"
              disabled={scoreDisabled}
              aria-label="Score Kick streamers and resolve links"
              title={
                noStreamers
                  ? 'No streamers to score yet'
                  : scoreNeeded
                    ? `${unscored > 0 ? `${unscored} streamer${unscored === 1 ? '' : 's'} not yet scored` : 'Newly enriched streamers'} — run scoring to flag affiliates + mine contacts`
                    : 'Re-score to refresh affiliate flags, contacts, and resolved links'
              }
              className={[
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40',
                scoreNeeded
                  ? 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100'
                  : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]',
              ].join(' ')}
            >
              {scorePending ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Scoring
                </>
              ) : (
                <>
                  <Sparkles className="h-3 w-3" /> Score &amp; resolve
                </>
              )}
            </button>
          </form>
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-[color:var(--color-text-secondary)]">
        <strong className="font-medium">Enrich</strong> opens the top streamers in a real browser to backfill socials,
        follower count, and casino promo / pinned-chat links. <strong className="font-medium">Score &amp; resolve</strong>{' '}
        then flags likely affiliates (niche score), mines contacts, and expands shortener links. Both are re-runnable.
        {moreToEnrich && (
          <>
            {' '}
            <span className="font-medium text-amber-700">
              Large jobs enrich in batches — {summary.pending} still pending, click Enrich again to continue.
            </span>
          </>
        )}
      </p>

      {(messages.length > 0 || errors.length > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
          {messages.map((m, i) => (
            <span key={`m${i}`} className="rounded-md bg-green-50 px-2 py-1 text-green-700">{m}</span>
          ))}
          {errors.map((e, i) => (
            <span key={`e${i}`} className="rounded-md bg-red-50 px-2 py-1 text-red-700">{e}</span>
          ))}
        </div>
      )}
    </section>
  )
}
