'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { syncMondayNow, type SyncMondayState } from '../actions'

const initial: SyncMondayState = null

export function SyncControls() {
  const [state, formAction, pending] = useActionState(syncMondayNow, initial)
  const [showToast, setShowToast] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (state) {
      // Surface the server-action outcome as a transient toast — this is
      // exactly the sync-external-state pattern effects are for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowToast(true)
      const t = setTimeout(() => setShowToast(false), 6000)
      if (state.status === 'ok') router.refresh()
      return () => clearTimeout(t)
    }
    return undefined
  }, [state, router])

  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-50"
      >
        <RefreshCw className={['h-3.5 w-3.5', pending ? 'animate-spin' : ''].join(' ')} />
        {pending ? 'Syncing all 4 boards…' : 'Sync Monday now'}
      </button>
      {showToast && state && (
        <span
          className={[
            'rounded-md px-2 py-1 text-[11px]',
            state.status === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800',
          ].join(' ')}
        >
          {state.status === 'ok' ? state.message : state.error}
        </span>
      )}
    </form>
  )
}
