'use client'

import { useActionState } from 'react'
import { Loader2, Megaphone, Sparkles } from 'lucide-react'
import { runFbAdvertiserAnalysis, type StageRunState } from '../actions'
import type { FbAdvertiserSummary } from '../_lib/queries'

const initialState: StageRunState = null

/**
 * Facebook Ad Library advertiser panel. Shown only for
 * search_engine='facebook' jobs. The keyword scrape (single pass) already
 * captured each advertiser Page + its ad landing links, so the only
 * operator-triggered action here is Phase 3:
 *   - Score & check → affiliate scoring + shortener resolution + Monday
 *     new-vs-known (runFbAdvertiserAnalysis, runs inline)
 *
 * (There is no "Enrich" step — Facebook's per-page Ad Library view is
 * unreliable, so link capture lives in the discovery scrape itself.)
 */
export function FbAdvertisersPanel({
  jobId,
  summary,
}: {
  jobId: string
  summary: FbAdvertiserSummary
}) {
  const [scoreState, scoreAction, scorePending] = useActionState(
    runFbAdvertiserAnalysis,
    initialState,
  )

  const noAdvertisers = summary.discovered === 0
  const scoreDisabled = scorePending || noAdvertisers
  const scoreNeeded = !noAdvertisers && (summary.unscored > 0 || summary.scored === 0)

  const message = scoreState?.status === 'ok' ? scoreState.message : null
  const error = scoreState?.status === 'error' ? scoreState.error : null

  return (
    <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          <Megaphone className="h-4 w-4" />
          Facebook advertisers
        </span>
        <span
          className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
          title="Operator-triggered — click ⭐ to score the discovered advertisers"
        >
          manual
        </span>

        <span className="text-[11px] text-[color:var(--color-text-secondary)]">
          {noAdvertisers ? (
            'No advertisers discovered'
          ) : (
            <>
              {summary.discovered} discovered
              {summary.scored > 0 && (
                <> · <span className="font-medium text-blue-700">{summary.likelyAffiliates} likely affiliate{summary.likelyAffiliates === 1 ? '' : 's'}</span></>
              )}
              {summary.newCandidates > 0 && (
                <> · <span className="font-medium text-purple-700">{summary.newCandidates} new lead{summary.newCandidates === 1 ? '' : 's'}</span></>
              )}
              {summary.unscored > 0 && summary.scored > 0 && <> · {summary.unscored} unscored</>}
            </>
          )}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <form action={scoreAction}>
            <input type="hidden" name="job_id" value={jobId} />
            <button
              type="submit"
              disabled={scoreDisabled}
              aria-label="Score Facebook advertisers and check Monday"
              title={
                noAdvertisers
                  ? 'No advertisers to score yet — run the Facebook scrape first'
                  : scoreNeeded
                    ? 'Score the discovered advertisers — flag affiliates, resolve ad links, mine contacts, and check Monday'
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
        The Facebook scrape captures each advertiser Page and the ad landing links from its ads.{' '}
        <strong className="font-medium">Score &amp; check</strong> flags likely casino affiliates (niche score), resolves
        shortener links, mines contacts from the ad copy, and checks each affiliate ID / Page name against Monday.
        Re-runnable.
      </p>

      {(message || error) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
          {message && <span className="rounded-md bg-green-50 px-2 py-1 text-green-700">{message}</span>}
          {error && <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">{error}</span>}
        </div>
      )}
    </section>
  )
}
