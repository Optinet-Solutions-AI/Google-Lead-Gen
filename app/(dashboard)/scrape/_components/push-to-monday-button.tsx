'use client'

import { useActionState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { pushJobToMondayAction, type PushJobState } from '../actions'

/** Compact "Push to Monday" control for the job detail-page header.
 *  Mirrors the action behind the list-row kebab's PushToMondaySection, but
 *  styled as a single header button with the result shown just beneath it. */
export function PushToMondayButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<PushJobState, FormData>(
    pushJobToMondayAction,
    null,
  )

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <form action={action}>
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending}
          title="Create Monday Leads-board items for this scrape's eligible results. Already-pushed and not-relevant rows are skipped."
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {pending ? 'Pushing…' : 'Push to Monday'}
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
