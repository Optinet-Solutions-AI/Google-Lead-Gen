'use client'

import { useActionState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { enqueueScrape, type EnqueueState } from '../actions'

type Profile = { country_code: string; country_name: string }

const initial: EnqueueState = null

export function EnqueueForm({ profiles }: { profiles: Profile[] }) {
  const [state, formAction, pending] = useActionState(enqueueScrape, initial)
  const formRef = useRef<HTMLFormElement>(null)
  const router = useRouter()

  useEffect(() => {
    if (state?.status === 'ok') {
      formRef.current?.reset()
      // Refresh the jobs table to show the new row immediately
      router.refresh()
    }
  }, [state, router])

  return (
    <form
      ref={formRef}
      action={formAction}
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_160px_100px_100px_auto] md:items-end">
        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Keyword
          <input
            name="keyword"
            type="text"
            required
            maxLength={500}
            placeholder='e.g. "Top 10 online casinos"'
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Country
          <select
            name="country_code"
            required
            defaultValue=""
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          >
            <option value="" disabled>
              Pick…
            </option>
            {profiles.map(p => (
              <option key={p.country_code} value={p.country_code}>
                {p.country_name} ({p.country_code})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Pages
          <input
            name="pages"
            type="number"
            min={1}
            max={10}
            defaultValue={1}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Priority
          <input
            name="priority"
            type="number"
            min={0}
            max={100}
            defaultValue={0}
            title="Higher = claimed sooner by an idle worker"
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="h-[34px] shrink-0 rounded-md bg-[color:var(--color-accent)] px-4 text-[13px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {pending ? 'Queuing…' : 'Enqueue scrape'}
        </button>
      </div>

      {state?.status === 'ok' && (
        <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-[12px] text-green-700">
          {state.message}
        </p>
      )}
      {state?.status === 'error' && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {state.error}
        </p>
      )}
    </form>
  )
}
