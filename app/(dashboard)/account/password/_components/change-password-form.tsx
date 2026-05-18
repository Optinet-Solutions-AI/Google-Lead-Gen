'use client'

import { useActionState, useEffect, useRef } from 'react'
import { changePasswordAction, type ChangePasswordState } from '../actions'

const initialState: ChangePasswordState = null

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, initialState)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state?.status === 'ok') {
      formRef.current?.reset()
    }
  }, [state])

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3">
      <Field name="current_password" label="Current password" autoComplete="current-password" />
      <Field name="new_password" label="New password" autoComplete="new-password" />
      <Field name="confirm_password" label="Confirm new password" autoComplete="new-password" />

      {state?.status === 'ok' && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-[12px] text-green-700">
          {state.message}
        </p>
      )}
      {state?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-md bg-[color:var(--color-accent)] px-3 py-2 text-[13px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
      >
        {pending ? 'Updating…' : 'Update password'}
      </button>
    </form>
  )
}

type FieldProps = {
  name: string
  label: string
  autoComplete: string
}

function Field({ name, label, autoComplete }: FieldProps) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
      {label}
      <input
        name={name}
        type="password"
        autoComplete={autoComplete}
        required
        minLength={12}
        className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
      />
    </label>
  )
}
