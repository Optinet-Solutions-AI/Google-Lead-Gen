'use client'

import { useActionState } from 'react'
import { CheckCircle2, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import { manualMondaySyncAction, type MondaySyncState } from '../_actions/sync'

const initial: MondaySyncState = null

export function SyncNowButton() {
  const [state, action, pending] = useActionState(manualMondaySyncAction, initial)

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          title="Re-sync all 4 Monday boards into Supabase. Takes a few minutes."
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {pending ? 'Syncing…' : 'Sync from Monday'}
        </button>
      </form>
      {pending && (
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          ~3–5 min for a full re-sync. Don&apos;t close this tab.
        </p>
      )}
      {state?.status === 'ok' && !pending && (
        <p className="inline-flex items-center gap-1 rounded-md bg-green-100 px-2 py-0.5 text-[11px] text-green-800">
          <CheckCircle2 className="h-3 w-3" />
          {state.message}
        </p>
      )}
      {state?.status === 'error' && !pending && (
        <p className="inline-flex items-center gap-1 rounded-md bg-red-100 px-2 py-0.5 text-[11px] text-red-800">
          <AlertTriangle className="h-3 w-3" />
          {state.error}
        </p>
      )}
    </div>
  )
}
