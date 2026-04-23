'use client'

import { useActionState } from 'react'
import { signInAction, type LoginState } from '../actions'

const initialState: LoginState = null

type Props = {
  redirectTo: string
}

export function LoginForm({ redirectTo }: Props) {
  const [state, formAction, pending] = useActionState(signInAction, initialState)

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="from" value={redirectTo} />

      <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
        Username
        <input
          name="username"
          type="text"
          autoComplete="username"
          required
          placeholder="Admin"
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
        />
      </label>

      <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
        />
      </label>

      {state?.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md bg-[color:var(--color-accent)] px-3 py-2 text-[13px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
