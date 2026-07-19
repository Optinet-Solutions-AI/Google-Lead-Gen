'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

const INTERVAL_MS = 30_000

export function AutoRefresh({ generatedAt }: { generatedAt: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [on, setOn] = useState(true)
  const [nextIn, setNextIn] = useState(INTERVAL_MS / 1000)

  useEffect(() => {
    if (!on) return
    // Reset the visible countdown when auto-refresh toggles back on —
    // synchronizes local UI state with the external timer we're
    // about to install, which is exactly what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNextIn(INTERVAL_MS / 1000)
    const tick = setInterval(() => {
      setNextIn(n => (n <= 1 ? INTERVAL_MS / 1000 : n - 1))
    }, 1000)
    const refresh = setInterval(() => {
      startTransition(() => router.refresh())
    }, INTERVAL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(refresh)
    }
  }, [on, router])

  const stamp = new Date(generatedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <div className="flex items-center gap-3 text-[11px] text-[color:var(--color-text-secondary)]">
      <span>
        Refreshed at <strong className="text-[color:var(--color-text-primary)]">{stamp}</strong>
      </span>
      <label className="inline-flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={on}
          onChange={e => setOn(e.target.checked)}
          className="h-3 w-3 accent-[color:var(--color-accent)]"
        />
        <span>Auto-refresh every 30s</span>
      </label>
      {on && <span className="tabular-nums">next in {nextIn}s</span>}
      <button
        type="button"
        onClick={() => startTransition(() => router.refresh())}
        disabled={isPending}
        className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-50"
      >
        {isPending ? 'Refreshing…' : 'Refresh now'}
      </button>
    </div>
  )
}
