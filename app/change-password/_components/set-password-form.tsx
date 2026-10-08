'use client'

import { useActionState, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { setInitialPasswordAction, type SetPasswordState } from '../actions'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy'

/**
 * The rules are shown as a live checklist rather than as a paragraph the
 * person reads once and then fails anyway. Each line ticks as they type, so a
 * rejected password is a surprise only if they ignored the list.
 */
export function SetPasswordForm() {
  const [state, action, pending] = useActionState<SetPasswordState, FormData>(
    setInitialPasswordAction,
    null,
  )
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(pw)).length
  const rules = [
    { label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: pw.length >= MIN_PASSWORD_LENGTH },
    { label: 'Three of: lowercase, uppercase, number, symbol', met: classes >= 3 },
    { label: 'Both entries match', met: pw.length > 0 && pw === confirm },
  ]

  return (
    <form action={action} className="mt-5 flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-[color:var(--color-text-primary)]">
          New password
        </span>
        <input
          type="password"
          name="new_password"
          value={pw}
          onChange={e => setPw(e.target.value)}
          autoComplete="new-password"
          autoFocus
          required
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-[color:var(--color-text-primary)]">
          Confirm new password
        </span>
        <input
          type="password"
          name="confirm_password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
        />
      </label>

      <ul className="flex flex-col gap-1 rounded-md bg-[color:var(--color-bg-secondary)] px-3 py-2">
        {rules.map(r => (
          <li
            key={r.label}
            className={[
              'flex items-center gap-1.5 text-[11px]',
              r.met ? 'text-emerald-700' : 'text-[color:var(--color-text-secondary)]',
            ].join(' ')}
          >
            <Check className={['h-3 w-3 shrink-0', r.met ? 'opacity-100' : 'opacity-25'].join(' ')} />
            {r.label}
          </li>
        ))}
      </ul>

      {state?.status === 'error' && (
        <p className="rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={pending || !rules.every(r => r.met)}
        className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-[color:var(--color-accent)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-text-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Set password and continue
      </button>
    </form>
  )
}
