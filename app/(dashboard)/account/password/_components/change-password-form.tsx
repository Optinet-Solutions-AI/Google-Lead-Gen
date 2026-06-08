'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Sparkles } from 'lucide-react'
import { changePasswordAction, type ChangePasswordState } from '../actions'

const initialState: ChangePasswordState = null

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, initialState)
  const formRef = useRef<HTMLFormElement>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    if (state?.status !== 'ok') return
    const clearForm = () => {
      formRef.current?.reset()
      setNewPassword('')
      setConfirmPassword('')
    }
    clearForm()
  }, [state])

  function suggestPassword() {
    const generated = generateStrongPassword(16)
    setNewPassword(generated)
    setConfirmPassword(generated)
  }

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3">
      {/* No minLength on current_password — pre-existing accounts may
          have been seeded with a shorter password, and forcing 12 here
          locks them out of changing it. Server still rejects with
          "Current password is incorrect" if it doesn't match. */}
      <Field name="current_password" label="Current password" autoComplete="current-password" />
      <Field
        name="new_password"
        label="New password"
        autoComplete="new-password"
        minLength={12}
        value={newPassword}
        onChange={setNewPassword}
        trailing={
          <button
            type="button"
            onClick={suggestPassword}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
            title="Generate a strong password and fill both fields"
          >
            <Sparkles className="h-3 w-3" />
            Suggest
          </button>
        }
      />
      <Field
        name="confirm_password"
        label="Confirm new password"
        autoComplete="new-password"
        minLength={12}
        value={confirmPassword}
        onChange={setConfirmPassword}
      />

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
  minLength?: number
  value?: string
  onChange?: (v: string) => void
  trailing?: React.ReactNode
}

function Field({ name, label, autoComplete, minLength, value, onChange, trailing }: FieldProps) {
  const [visible, setVisible] = useState(false)
  const controlled = onChange !== undefined
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
      <span className="flex items-center justify-between">
        <span>{label}</span>
        {trailing}
      </span>
      <span className="relative">
        <input
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          {...(minLength != null ? { minLength } : {})}
          {...(controlled ? { value: value ?? '', onChange: e => onChange!(e.target.value) } : {})}
          className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 pr-10 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => setVisible(v => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          title={visible ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex items-center px-2.5 text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-text-primary)]"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </span>
    </label>
  )
}

/**
 * Generate a strong password client-side using the Web Crypto API.
 * Guarantees at least one uppercase, one lowercase, one digit, and
 * one special character so it satisfies any policy a server might
 * tighten to in future. 16 chars is comfortably above the 12 min
 * we enforce today.
 */
function generateStrongPassword(length: number): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'   // dropped I O for legibility
  const lower = 'abcdefghijkmnpqrstuvwxyz'   // dropped l o for legibility
  const digit = '23456789'                    // dropped 0 1 for legibility
  const symbol = '!@#$%^&*()-_=+'
  const all = upper + lower + digit + symbol

  function pick(set: string): string {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return set[buf[0]! % set.length]!
  }

  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)]
  for (let i = chars.length; i < length; i += 1) chars.push(pick(all))

  // Fisher-Yates shuffle so the guaranteed slots aren't always at the start.
  const buf = new Uint32Array(chars.length)
  crypto.getRandomValues(buf)
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = buf[i]! % (i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}
