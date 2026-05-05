'use client'

import { useActionState, useEffect, useRef } from 'react'
import { BellPlus, CheckCircle2, Loader2 } from 'lucide-react'
import { createRecipientAction, type RecipientFormState } from '../actions'

const initial: RecipientFormState = null

type Props = {
  countries: Array<{ code: string; name: string }>
}

export function AddRecipientForm({ countries }: Props) {
  const [state, action, pending] = useActionState(createRecipientAction, initial)
  const formRef = useRef<HTMLFormElement | null>(null)

  // Reset the form on a successful add so the next entry starts clean.
  useEffect(() => {
    if (state?.status === 'ok') {
      formRef.current?.reset()
    }
  }, [state])

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3 flex items-center gap-2">
        <BellPlus className="h-4 w-4 text-[color:var(--color-accent)]" />
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Add a recipient
        </h2>
      </header>
      <p className="mb-3 text-[11px] text-[color:var(--color-text-secondary)]">
        Each recipient gets one email per qualifying lead. Leave the
        country blank to receive every alert; pick a country to scope
        this recipient to leads scraped from that country only (e.g.
        the German affiliate manager only gets DE leads).
      </p>

      <form ref={formRef} action={action} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Email" required>
            <input
              type="email"
              name="email"
              required
              autoComplete="off"
              placeholder="manager@example.com"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] text-[color:var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            />
          </Field>
          <Field label="Display name (optional)">
            <input
              type="text"
              name="name"
              autoComplete="off"
              placeholder="Jane Doe"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] text-[color:var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            />
          </Field>
          <Field label="Country (optional)">
            <select
              name="country_code"
              defaultValue=""
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] text-[color:var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            >
              <option value="">All countries</option>
              {countries.map(c => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes (optional)">
            <input
              type="text"
              name="notes"
              autoComplete="off"
              placeholder="e.g. DACH region affiliate manager"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] text-[color:var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {state?.status === 'error' && (
              <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                {state.error}
              </p>
            )}
            {state?.status === 'ok' && (
              <p className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
                <CheckCircle2 className="h-3 w-3" />
                {state.message}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-3 py-1.5 text-[12px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <BellPlus className="h-3.5 w-3.5" />
            )}
            Add recipient
          </button>
        </div>
      </form>
    </section>
  )
}

function Field({
  label,
  children,
  required = false,
}: {
  label: string
  children: React.ReactNode
  required?: boolean
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-[color:var(--color-text-secondary)]">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </span>
      {children}
    </label>
  )
}
