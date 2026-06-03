'use client'

import { useActionState } from 'react'
import { AtSign, CheckCircle2, Loader2, Play, Sparkles } from 'lucide-react'
import {
  runXProfileEnrichment,
  runXCreatorAnalysis,
  type StageRunState,
} from '../actions'
import type { XCreatorSummary } from '../_lib/queries'

const initialState: StageRunState = null

/**
 * X (x.com) creator panel (Phases 2 + 3). Shown only for search_engine='x'
 * jobs. Two operator-triggered ▶ actions:
 *   - Enrich profiles → Phase 2 browser scrape (runXProfileEnrichment,
 *     enqueues a scrape_queue job the GoLogin workers claim)
 *   - Score & check   → Phase 3 affiliate scoring + shortener resolution +
 *     Monday new-vs-known (runXCreatorAnalysis, runs inline)
 *
 * Mirrors KickStreamersPanel / YoutubeChannelsPanel.
 */
export function XCreatorsPanel({
  jobId,
  summary,
}: {
  jobId: string
  summary: XCreatorSummary
}) {
  const [enrichState, enrichAction, enrichPending] = useActionState(
    runXProfileEnrichment,
    initialState,
  )
  const [scoreState, scoreAction, scorePending] = useActionState(
    runXCreatorAnalysis,
    initialState,
  )

  const inflight = summary.inflight
  const nothingToEnrich = summary.pending === 0 && summary.discovered > 0
  const noCreators = summary.discovered === 0
  const enrichDisabled = enrichPending || inflight || nothingToEnrich || noCreators
  const scoreDisabled = scorePending || noCreators

  const enrichedSome = summary.enriched > 0
  const moreToEnrich = summary.pending > 0 && enrichedSome
  const unscored = Math.max(0, summary.discovered - summary.scored)
  const scoreNeeded = !noCreators && !inflight && (unscored > 0 || (enrichedSome && summary.scored === 0))

  const messages = [
    enrichState?.status === 'ok' ? enrichState.message : null,
    scoreState?.status === 'ok' ? scoreState.message : null,
  ].filter(Boolean) as string[]
  const errors = [
    enrichState?.status === 'error' ? enrichState.error : null,
    scoreState?.status === 'error' ? scoreState.error : null,
  ].filter(Boolean) as string[]

  const enrichTitle = noCreators
    ? 'No creators discovered yet — run the X scrape first'
    : inflight
      ? 'Profile enrichment already running — wait for it to finish'
      : nothingToEnrich
        ? 'Every discovered creator already enriched'
        : 'Enrich the discovered profiles (followers, bio, pinned tweet, website, affiliate links)'

  return (
    <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          <AtSign className="h-4 w-4" />
          X creators
        </span>
        <span
          className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
          title="Operator-triggered — click ▶ to render each x.com/{handle} profile"
        >
          manual
        </span>

        <span className="text-[11px] text-[color:var(--color-text-secondary)]">
          {noCreators ? (
            'No creators discovered'
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
              {summary.newCandidates > 0 && (
                <> · <span className="font-medium text-purple-700">{summary.newCandidates} new lead{summary.newCandidates === 1 ? '' : 's'}</span></>
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
              aria-label="Enrich X creator profiles"
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
              aria-label="Score X creators and check Monday"
              title={
                noCreators
                  ? 'No creators to score yet'
                  : scoreNeeded
                    ? `${unscored > 0 ? `${unscored} creator${unscored === 1 ? '' : 's'} not yet scored` : 'Newly enriched creators'} — run scoring to flag affiliates, resolve links, mine contacts, and check Monday`
                    : 'Re-score to refresh affiliate flags, contacts, resolved links, and Monday checks'
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
                  <Sparkles className="h-3 w-3" /> Score &amp; check
                </>
              )}
            </button>
          </form>
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-[color:var(--color-text-secondary)]">
        <strong className="font-medium">Enrich</strong> opens the discovered profiles in a real (X-logged-in) browser to
        backfill follower counts, bio, pinned tweet, website, socials, and affiliate links.{' '}
        <strong className="font-medium">Score &amp; check</strong> then flags likely affiliates (niche score), resolves
        shortener links, mines contacts, and checks each affiliate ID / @handle against Monday. Both are re-runnable.
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
