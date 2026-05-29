'use client'

import { useActionState, useState, useTransition } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import {
  deactivateCredentialAction,
  revealCredentialPasswordAction,
  setCredentialAction,
  type CredentialFormState,
  type DeactivateState,
} from '../actions'

const initialSet: CredentialFormState = null
const initialDelete: DeactivateState = null

type Props = {
  country: {
    country_code: string
    country_name: string
    requires_google_login: boolean
    is_google_logged_in: boolean
  }
  credential: {
    id: string
    country_code: string
    email: string
    is_active: boolean
    last_used_at: string | null
    last_used_status: string | null
    notes: string | null
    updated_at: string
  } | null
  isAdmin: boolean
}

function statusTone(status: string | null): string {
  if (!status) return 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]'
  if (status === 'success') return 'bg-emerald-100 text-emerald-800'
  if (status.startsWith('failed')) return 'bg-rose-100 text-rose-800'
  if (status === 'checkpoint') return 'bg-amber-100 text-amber-800'
  return 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]'
}

export function CredentialRow({ country, credential, isAdmin }: Props) {
  const [editing, setEditing] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const [setState, setAction, setPending] = useActionState(setCredentialAction, initialSet)
  const [deleteState, deleteAction, deletePending] = useActionState(
    deactivateCredentialAction,
    initialDelete,
  )

  // Reveal state for the existing-credential row. Fetched lazily via
  // server action so the password isn't on-page until the operator
  // clicks Show. Stays in component state only — no localStorage.
  const [revealedPwd, setRevealedPwd] = useState<string | null>(null)
  const [revealError, setRevealError] = useState<string | null>(null)
  const [revealPending, startReveal] = useTransition()
  const [copied, setCopied] = useState(false)
  const handleReveal = () => {
    if (revealedPwd !== null) {
      setRevealedPwd(null)
      setRevealError(null)
      return
    }
    startReveal(async () => {
      setRevealError(null)
      const res = await revealCredentialPasswordAction(country.country_code)
      if (res.ok) {
        setRevealedPwd(res.password)
      } else {
        setRevealError(res.error)
      }
    })
  }
  const handleCopy = async () => {
    if (!revealedPwd) return
    try {
      await navigator.clipboard.writeText(revealedPwd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore — older browsers / Safari fallback */
    }
  }

  const errorMsg =
    setState?.status === 'error'
      ? setState.error
      : deleteState?.status === 'error'
        ? deleteState.error
        : revealError

  const showsCheckmark = setState?.status === 'ok' && !editing
  const hasCreds = credential !== null

  return (
    <div className="flex flex-col gap-2 px-3 py-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound
          className={[
            'h-4 w-4 shrink-0',
            hasCreds
              ? 'text-emerald-600'
              : country.requires_google_login
                ? 'text-amber-600'
                : 'text-[color:var(--color-text-secondary)]/40',
          ].join(' ')}
        />

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-[color:var(--color-text-primary)]">
            {country.country_name}{' '}
            <span className="text-[color:var(--color-text-secondary)]">
              ({country.country_code})
            </span>
            {country.requires_google_login && (
              <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                requires login
              </span>
            )}
            {country.requires_google_login && !hasCreds && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
                <AlertTriangle className="h-2.5 w-2.5" />
                no credentials
              </span>
            )}
            {showsCheckmark && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                <CheckCircle2 className="h-2.5 w-2.5" />
                saved
              </span>
            )}
          </p>
          {hasCreds && credential && (
            <p
              className="truncate text-[11px] text-[color:var(--color-text-secondary)]"
              // Locale-formatted timestamp differs between Node's en-US
              // SSR and the browser's locale; suppress the hydration
              // warning. See BUGS.md R2-20.
              suppressHydrationWarning
            >
              {credential.email}
              {credential.last_used_at && (
                <>
                  {' · last used '}
                  {new Date(credential.last_used_at).toLocaleString()}{' '}
                  {credential.last_used_status && (
                    <span
                      className={[
                        'ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        statusTone(credential.last_used_status),
                      ].join(' ')}
                    >
                      {credential.last_used_status}
                    </span>
                  )}
                </>
              )}
              {credential.notes && <span className="ml-2 italic">— {credential.notes}</span>}
            </p>
          )}
          {revealedPwd !== null && (
            <p className="mt-1 inline-flex flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
              <span className="font-semibold uppercase tracking-wide text-[10px]">
                password:
              </span>
              <code className="rounded bg-white/60 px-1.5 py-0.5 font-mono text-[11px]">
                {revealedPwd}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className={[
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                  copied
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border-amber-200 bg-white text-amber-900 hover:bg-amber-100',
                ].join(' ')}
                title={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
              >
                {copied ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </p>
          )}
        </div>

        {!editing && hasCreds && (
          <button
            type="button"
            onClick={handleReveal}
            disabled={revealPending}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
            title={revealedPwd ? 'Hide the password' : 'Reveal the stored password'}
          >
            {revealPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : revealedPwd ? (
              <EyeOff className="h-3 w-3" />
            ) : (
              <Eye className="h-3 w-3" />
            )}
            {revealedPwd ? 'Hide' : 'Show'}
          </button>
        )}

        {!editing && isAdmin && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            <Pencil className="h-3 w-3" />
            {hasCreds ? 'Replace' : 'Add'}
          </button>
        )}

        {!editing && isAdmin && hasCreds && (
          <form
            action={deleteAction}
            onSubmit={e => {
              if (
                !confirm(
                  `Remove the Google credential for ${country.country_name}? The scraper will fall back to the Captcha solver on next logged-out detection.`,
                )
              ) {
                e.preventDefault()
              }
            }}
          >
            <input type="hidden" name="country_code" value={country.country_code} />
            <button
              type="submit"
              disabled={deletePending}
              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {deletePending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Remove
            </button>
          </form>
        )}
      </div>

      {editing && isAdmin && (
        <form
          action={setAction}
          className="grid gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/30 p-3 md:grid-cols-[1fr_1fr_1fr_auto]"
          onSubmit={() => {
            // Server action returns -> useEffect would close the form on
            // success, but useActionState doesn't fire effects; we rely
            // on the next render to clear `setState`. Closing immediately
            // here would race with pending. Leave editing open until the
            // user clicks Done.
          }}
        >
          <input type="hidden" name="country_code" value={country.country_code} />
          <Field label="Google email" required>
            <input
              type="email"
              name="email"
              required
              autoComplete="off"
              defaultValue={credential?.email ?? ''}
              placeholder="scraper-de@example.com"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            />
          </Field>
          <Field label="Password" required>
            <div className="flex gap-1">
              <input
                type={showPwd ? 'text' : 'password'}
                name="password"
                required
                autoComplete="new-password"
                placeholder="••••••••"
                className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => setShowPwd(s => !s)}
                title={showPwd ? 'Hide password' : 'Show password'}
                className="shrink-0 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
              >
                {showPwd ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
          </Field>
          <Field label="Notes (optional)">
            <input
              type="text"
              name="notes"
              autoComplete="off"
              defaultValue={credential?.notes ?? ''}
              placeholder="e.g. recovery email is X@Y"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            />
          </Field>
          <div className="flex items-end gap-1">
            <button
              type="submit"
              disabled={setPending}
              className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:opacity-40"
            >
              {setPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
            >
              <X className="h-3 w-3" />
              Done
            </button>
          </div>
        </form>
      )}

      {errorMsg && (
        <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {errorMsg}
        </p>
      )}
    </div>
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
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </span>
      {children}
    </label>
  )
}
