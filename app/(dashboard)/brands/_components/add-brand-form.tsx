'use client'

import { useActionState, useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'
import { addRoosterBrand, type AddBrandState } from '../actions'

const initial: AddBrandState = null

export function AddBrandForm() {
  const [state, action, pending] = useActionState(addRoosterBrand, initial)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state?.status === 'ok') {
      formRef.current?.reset()
    }
  }, [state])

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3"
    >
      <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
        Domain
        <input
          type="text"
          name="domain"
          required
          placeholder="rooster-brand.com"
          className="w-[220px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[12px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
        Brand name
        <input
          type="text"
          name="brand_name"
          placeholder="(optional)"
          className="w-[220px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[12px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" />
        {pending ? 'Adding…' : 'Add brand'}
      </button>
      {state?.status === 'ok' && (
        <span className="rounded-md bg-green-50 px-2 py-1 text-[11px] text-green-700">{state.message}</span>
      )}
      {state?.status === 'error' && (
        <span className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">{state.error}</span>
      )}
    </form>
  )
}
