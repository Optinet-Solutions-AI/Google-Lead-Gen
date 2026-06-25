'use client'

import { useActionState } from 'react'
import { CheckCircle2, Loader2, MonitorPlay, Play, Sparkles } from 'lucide-react'
import {
  runYoutubeContactEnrichment,
  runYoutubeChannelAnalysis,
  type StageRunState,
} from '../actions'
import type { YoutubeChannelSummary } from '../_lib/queries'

const initialState: StageRunState = null

/**
 * YouTube channel panel (Phases 2 + 3). Shown only for search_engine='youtube'
 * jobs. Two operator-triggered ▶ actions:
 *   - Enrich contacts  → Phase 2 browser scrape (runYoutubeContactEnrichment,
 *     enqueues a scrape_queue job the GoLogin workers claim)
 *   - Score & check    → Phase 3 affiliate scoring + S-tag extraction +
 *     new-vs-known check (runYoutubeChannelAnalysis, runs inline)
 *
 * Mirrors KickStreamersPanel.
 */
export function YoutubeChannelsPanel({
  jobId,
  summary,
}: {
  jobId: string
  summary: YoutubeChannelSummary
}) {
  const [enrichState, enrichAction, enrichPending] = useActionState(
    runYoutubeContactEnrichment,
    initialState,
  )
  const [scoreState, scoreAction, scorePending] = useActionState(
    runYoutubeChannelAnalysis,
    initialState,
  )

  const inflight = summary.inflight
  const nothingToEnrich = summary.pending === 0 && summary.discovered > 0
  const noChannels = summary.discovered === 0
  const enrichDisabled = enrichPending || inflight || nothingToEnrich || noChannels
  const scoreDisabled = scorePending || noChannels

  const messages = [
    enrichState?.status === 'ok' ? enrichState.message : null,
    scoreState?.status === 'ok' ? scoreState.message : null,
  ].filter(Boolean) as string[]
  const errors = [
    enrichState?.status === 'error' ? enrichState.error : null,
    scoreState?.status === 'error' ? scoreState.error : null,
  ].filter(Boolean) as string[]

  const enrichTitle = noChannels
    ? 'No channels discovered yet — run the YouTube scrape first'
    : inflight
      ? 'Contact enrichment already running — wait for it to finish'
      : nothingToEnrich
        ? 'Every discovered channel already enriched'
        : 'Enrich the top channels (website, socials, About-tab email)'

  return (
    <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          <MonitorPlay className="h-4 w-4" />
          YouTube channels
        </span>
        <span
          className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
          title="Operator-triggered — click ▶ to open each channel's About tab and score affiliate signals"
        >
          manual
        </span>

        <span className="text-[11px] text-[color:var(--color-text-secondary)]">
          {noChannels ? (
            'No channels discovered'
          ) : (
            <>
              {summary.discovered} discovered ·{' '}
              <span className="font-medium text-emerald-700">{summary.enriched} enriched</span>
              {summary.pending > 0 && <> · {summary.pending} pending</>}
              {summary.captchaBlocked > 0 && (
                <> · <span className="text-amber-700">{summary.captchaBlocked} captcha-blocked</span></>
              )}
              {summary.notRelevant > 0 && (
                <>
                  {' '}·{' '}
                  <span
                    className="cursor-help text-[color:var(--color-text-secondary)]"
                    title="Scored but no casino funnel link — slot-gameplay vloggers, land-based-casino vlogs, news. Not actionable affiliates. Hidden from the results table by default; use “Show all” there to review them."
                  >
                    {summary.notRelevant} no-funnel filtered
                  </span>
                </>
              )}
              {summary.scored > 0 && (
                <> · <span className="font-medium text-blue-700">{summary.likelyAffiliates} likely affiliate{summary.likelyAffiliates === 1 ? '' : 's'}</span></>
              )}
              {summary.newCandidates > 0 && (
                <> · <span className="font-medium text-fuchsia-700">{summary.newCandidates} new lead{summary.newCandidates === 1 ? '' : 's'}</span></>
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
              aria-label="Enrich YouTube channel contacts"
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
                  <Play className={['h-3 w-3', enrichPending ? 'animate-pulse' : ''].join(' ')} /> Enrich contacts
                </>
              )}
            </button>
          </form>

          <form action={scoreAction}>
            <input type="hidden" name="job_id" value={jobId} />
            <button
              type="submit"
              disabled={scoreDisabled}
              aria-label="Score YouTube channels and check affiliate IDs"
              title={
                noChannels
                  ? 'No channels to score yet'
                  : 'Score channels, extract affiliate S-tags from video descriptions, and flag new vs known'
              }
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
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
        <strong className="font-medium">Enrich</strong> opens the top channels in a real browser to backfill website,
        socials, and the About-tab email (reCAPTCHA-gated). <strong className="font-medium">Score &amp; check</strong>{' '}
        then flags likely affiliates, mines affiliate S-tags from the video descriptions, and checks each channel
        against the company database (by its @handle) — flagging channels that aren’t on Monday yet as{' '}
        <strong className="font-medium">new leads</strong>. Both are re-runnable.
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
