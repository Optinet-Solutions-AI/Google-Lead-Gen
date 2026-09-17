'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'

/**
 * UI-only "Remove from queue". Confirms inline, then explains that the
 * backend hook is not wired yet. Swap the `setDone(true)` for the real
 * cancel action when the backend lands.
 */
export function RemoveFromQueueButton({ jobId, keyword }: { jobId: string; keyword: string }) {
  const [confirm, setConfirm] = useState(false)
  const [done, setDone] = useState(false)

  if (done) {
    return <span className="text-[11px] text-amber-800" title={jobId}>Preview: removal not wired yet</span>
  }
  if (confirm) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => setDone(true)}
          className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() => setConfirm(false)}
          className="rounded-md px-2 py-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          Keep
        </button>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => setConfirm(true)}
      title={`Remove "${keyword}" from the queue`}
      className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-2 py-1 text-[11px] text-[color:var(--color-text-primary)] hover:border-red-200 hover:bg-red-50 hover:text-red-700"
    >
      <Trash2 className="h-3 w-3" /> Remove
    </button>
  )
}
