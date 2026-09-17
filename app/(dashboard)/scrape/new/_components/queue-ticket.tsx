'use client'

import Link from 'next/link'
import { CalendarClock, Plus, Table2, Ticket } from 'lucide-react'
import {
  ENRICHMENT_STAGES,
  dayLabel,
  engineDef,
  flagEmoji,
  langName,
  utcDay,
  type ScrapeDraft,
} from '../_lib/wizard-helpers'

/** What the scrape page already knows about the queue, passed down so the
 *  ticket can show a real position and wait rather than a guess. */
export type QueueEstimate = {
  /** Ready-to-run jobs already queued for this country. */
  pendingInCountry: number
  /** Jobs running on this country right now. */
  runningInCountry: number
  /** Workers this country can use at once. */
  capacity: number
  /** Minutes until a job joining the back of this country's queue starts. */
  etaMinutes: number | null
  /** Ready-to-run jobs across the whole fleet. */
  totalPending: number
}

export type TicketInfo = {
  draft: ScrapeDraft
  countryName: string
  estimate: QueueEstimate | null
  /** Reference shown on the stub. A real batch number replaces this once the
   *  backend is connected. */
  reference: string
}

export function formatWait(minutes: number | null): string {
  if (minutes === null) return 'Not enough history to estimate'
  if (minutes <= 0) return 'Starting now'
  if (minutes < 1) return 'Under a minute'
  if (minutes < 60) return `About ${Math.round(minutes)} minutes`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m === 0 ? `About ${h} hour${h === 1 ? '' : 's'}` : `About ${h}h ${m}m`
}

/**
 * Confirmation shown after a scrape is submitted, built like a cloakroom
 * ticket: the queue position is the whole point, everything else is the stub.
 */
export function QueueTicket({ info, onCreateAnother }: { info: TicketInfo; onCreateAnother: () => void }) {
  const { draft, countryName, estimate, reference } = info
  const def = engineDef(draft.search_engine)
  const scheduled = draft.mode === 'schedule' && draft.scheduled_at
  // The job joins the back of its country's queue.
  const position = estimate ? estimate.pendingInCountry + 1 : null
  const ahead = estimate?.pendingInCountry ?? null

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-primary)] shadow-sm">
        {/* Stub head */}
        <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)] px-5 py-3">
          <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--color-text-secondary)]">
            <Ticket className="h-3.5 w-3.5" />
            Scrape ticket
          </span>
          <span className="font-mono text-[11px] text-[color:var(--color-text-secondary)]">{reference}</span>
        </div>

        {/* The number */}
        <div className="flex flex-col items-center gap-1 px-5 pb-5 pt-6 text-center">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--color-text-secondary)]">
            {scheduled ? 'Scheduled' : 'Queue position'}
          </span>
          {scheduled ? (
            <>
              <span className="inline-flex items-center gap-2 text-[34px] font-semibold leading-tight tracking-tight text-[color:var(--color-text-primary)]">
                <CalendarClock className="h-7 w-7 text-[color:var(--color-text-secondary)]" />
                {new Date(draft.scheduled_at!).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="text-[12.5px] text-[color:var(--color-text-secondary)]">
                It joins the queue then, and spends {dayLabel(utcDay(draft.scheduled_at!)).toLowerCase()}&rsquo;s quota.
              </span>
            </>
          ) : (
            <>
              <span className="text-[64px] font-semibold leading-none tracking-tight text-[color:var(--color-text-primary)] tabular-nums">
                {position === null ? '—' : `#${position}`}
              </span>
              <span className="text-[12.5px] text-[color:var(--color-text-secondary)]">
                {ahead === null
                  ? `Waiting for a ${countryName} worker`
                  : ahead === 0
                    ? `Next in line for ${countryName}`
                    : `${ahead} job${ahead === 1 ? '' : 's'} ahead of you on ${countryName}`}
              </span>
            </>
          )}
          <span
            className={[
              'mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium',
              scheduled ? 'bg-sky-100 text-sky-800' : 'bg-amber-100 text-amber-900',
            ].join(' ')}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${scheduled ? 'bg-sky-600' : 'bg-amber-600'}`} />
            {scheduled ? 'Scheduled' : 'Pending'}
          </span>
        </div>

        {/* Perforation */}
        <div className="relative h-0 border-t border-dashed border-[color:var(--color-border-strong)]">
          <span className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-[color:var(--color-bg-secondary)]" />
          <span className="absolute -right-2 -top-2 h-4 w-4 rounded-full bg-[color:var(--color-bg-secondary)]" />
        </div>

        {/* Stub detail */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 text-[12.5px] sm:grid-cols-3">
          <Field label="Estimated wait" value={scheduled ? 'Starts at the scheduled time' : formatWait(estimate?.etaMinutes ?? null)} />
          <Field label="Keywords queued" value={`${draft.keywords.length}`} />
          <Field label="Source" value={def?.label ?? draft.search_engine} />
          <Field label="Country" value={`${flagEmoji(draft.country_code)} ${countryName}`} />
          <Field label="Language" value={langName(draft.language)} />
          <Field label="Pages" value={`${draft.pages} per keyword`} />
          {def?.kind === 'serp' && (
            <Field label="Device" value={draft.view_mode === 'both' ? 'Desktop and mobile' : draft.view_mode === 'desktop' ? 'Desktop only' : 'Mobile only'} />
          )}
          {def?.kind === 'serp' && (
            <Field
              label="Enrichment"
              value={draft.with_enrichment ? draft.enrichment_stages.map(k => ENRICHMENT_STAGES.find(s => s.key === k)?.label ?? k).join(', ') : 'None'}
            />
          )}
          {def?.kind === 'social' && (
            <Field label="Keep" value={draft.top_n_by_follower === null ? 'All accounts' : `Top ${draft.top_n_by_follower} by followers`} />
          )}
          {estimate && (
            <Field
              label="Fleet right now"
              value={`${estimate.runningInCountry} of ${estimate.capacity} ${countryName} workers busy · ${estimate.totalPending} queued overall`}
            />
          )}
        </dl>

        {draft.keywords.length > 0 && (
          <div className="border-t border-[color:var(--color-border)] px-5 py-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">Keywords</div>
            <ul className="flex flex-wrap gap-1">
              {draft.keywords.map(k => (
                <li key={k} className="rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[12px] text-[color:var(--color-text-primary)]">
                  {k}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCreateAnother}
          className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-text-primary)] px-4 py-2.5 text-[13px] font-medium text-white hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Create another scrape
        </button>
        <Link
          href="/scrape"
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-2.5 text-[13px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
        >
          <Table2 className="h-4 w-4" /> View scraping table
        </Link>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-text-primary)]">{value}</dd>
    </div>
  )
}
