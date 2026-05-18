'use client'

import { Trash2 } from 'lucide-react'
import { deleteScheduledSet } from '../actions'

/**
 * Confirm-gated delete for a scheduled set. The page is a server
 * component, so the form needs to live in a client wrapper to attach
 * the `onSubmit` confirm. Submit still goes through the server action
 * — which `redirect()`s to /schedules on success — so no router push
 * or try/catch is needed here.
 */
export function DeleteScheduleSetButton({ id, name }: { id: string; name: string }) {
  return (
    <form
      action={deleteScheduledSet}
      className="ml-auto"
      onSubmit={e => {
        if (!confirm(`Delete schedule "${name}"? Every keyword inside will also be removed. This can't be undone.`)) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[12px] font-medium text-red-700 hover:bg-red-50"
      >
        <Trash2 className="h-3 w-3" />
        Delete schedule
      </button>
    </form>
  )
}
