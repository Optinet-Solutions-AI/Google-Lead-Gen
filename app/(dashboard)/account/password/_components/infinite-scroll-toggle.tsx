'use client'

import { useActionState } from 'react'
import { CheckCircle2, Loader2, Power } from 'lucide-react'
import {
  setInfiniteScrollPreference,
  type PreferenceState,
} from '../actions'

const initial: PreferenceState = null

/**
 * Per-user toggle for "auto-load more rows on scroll". Default OFF
 * so the Rows picker on /leads + /scrape is a hard limit. Flip ON
 * to get the old infinite-scroll behaviour back.
 */
export function InfiniteScrollToggle({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(setInfiniteScrollPreference, initial)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold',
            enabled
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
          ].join(' ')}
        >
          <span
            className={[
              'h-2 w-2 rounded-full',
              enabled ? 'bg-emerald-600' : 'bg-[color:var(--color-text-secondary)]',
            ].join(' ')}
          />
          Auto-load on scroll is {enabled ? 'ON' : 'OFF'}
        </span>

        <form action={action}>
          <input type="hidden" name="value" value={enabled ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={pending}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              enabled
                ? 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]'
                : 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100',
            ].join(' ')}
            title={
              enabled
                ? 'Stop auto-loading — the Rows picker becomes a hard limit again'
                : 'Auto-load more rows when you scroll past the visible page'
            }
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Power className="h-3.5 w-3.5" />
            )}
            Turn auto-load {enabled ? 'OFF' : 'ON'}
          </button>
        </form>
      </div>

      {state?.status === 'ok' && (
        <p className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
          <CheckCircle2 className="h-3 w-3" />
          {state.message}
        </p>
      )}
      {state?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
    </div>
  )
}
