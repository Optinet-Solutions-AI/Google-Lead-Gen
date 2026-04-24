'use client'

import { useActionState } from 'react'
import { Database } from 'lucide-react'
import { checkMondayDuplicates, type CheckMondayState } from '../actions'

const initial: CheckMondayState = null

export function CheckMondayButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(checkMondayDuplicates, initial)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <form action={formAction}>
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-50"
        >
          <Database className="h-3 w-3" />
          {pending ? 'Checking…' : 'Check Monday duplicates'}
        </button>
      </form>

      {state?.status === 'ok' && (
        <span className="rounded-md bg-green-50 px-2.5 py-1 text-[11px] text-green-700">
          {state.message}
        </span>
      )}
      {state?.status === 'error' && (
        <span className="rounded-md bg-red-50 px-2.5 py-1 text-[11px] text-red-700">
          {state.error}
        </span>
      )}
    </div>
  )
}
