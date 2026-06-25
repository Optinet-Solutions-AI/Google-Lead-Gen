'use client'

import { useActionState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { pushJobToMondayAction, type PushJobState } from '../actions'
import { isSocialEngine } from '@/lib/monday/engine-config'

/** Compact "Push to Monday" control for the job detail-page header.
 *  Mirrors the action behind the list-row kebab's PushToMondaySection, but
 *  styled as a single header button with the result shown just beneath it.
 *
 *  For the social engines (Kick / YouTube / X / Facebook / TikTok / Snapchat
 *  / Telegram / Twitch) the job push only sends the results flagged as likely
 *  affiliates — NOT every discovered streamer/creator (see lib/monday/push-job
 *  + engine-config). Spell that out in the label + tooltip so it's clear the
 *  button isn't a "push everything" control (QA: Supriya, 2026-06-24). */
export function PushToMondayButton({
  jobId,
  engine,
}: {
  jobId: string
  engine?: string | null
}) {
  const [state, action, pending] = useActionState<PushJobState, FormData>(
    pushJobToMondayAction,
    null,
  )

  const affiliatesOnly = isSocialEngine(engine)
  const idleLabel = affiliatesOnly ? 'Push affiliates to Monday' : 'Push to Monday'
  const title = affiliatesOnly
    ? 'Pushes only the results flagged as likely affiliates (not every discovered profile) to the Monday Leads board, in one click. Already-pushed ones are skipped. Push a non-affiliate by hand from its row.'
    : "Create Monday Leads-board items for this scrape's eligible results. Already-pushed and not-relevant rows are skipped."

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <form action={action}>
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending}
          title={title}
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {pending ? 'Pushing…' : idleLabel}
        </button>
      </form>
      {state && (
        <span
          className={[
            'max-w-[260px] rounded-md px-2 py-1 text-right text-[10px]',
            state.status === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800',
          ].join(' ')}
        >
          {state.status === 'ok' ? state.message : state.error}
        </span>
      )}
    </span>
  )
}
