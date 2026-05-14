'use client'

import { useActionState, useEffect, useState } from 'react'
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  ShieldPlus,
  UserPlus,
} from 'lucide-react'
import { createUserAction, type CreateUserState } from '../actions'
import {
  suggestIdentity,
  suggestPassword,
} from '../_lib/suggest'

const initial: CreateUserState = null

export function AddUserForm() {
  const [state, action, pending] = useActionState(createUserAction, initial)
  // Start blank so the SSR + client first-render markup match — Math.random()
  // in a lazy initialiser produces a hydration mismatch on force-dynamic pages.
  // Populate on mount; reset to a fresh suggestion after a successful create.
  const [identity, setIdentity] = useState<{ username: string; displayName: string }>({
    username: '',
    displayName: '',
  })
  const [password, setPassword] = useState<string>('')
  const [showPassword, setShowPassword] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIdentity(suggestIdentity())
    setPassword(suggestPassword())
  }, [])

  useEffect(() => {
    if (state?.status === 'ok') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdentity(suggestIdentity())
      setPassword(suggestPassword())
      setIsAdmin(false)
    }
  }, [state])

  const regenerateIdentity = () => setIdentity(suggestIdentity())

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3 flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-[color:var(--color-accent)]" />
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Add a user
        </h2>
      </header>
      <p className="mb-3 text-[11px] text-[color:var(--color-text-secondary)]">
        Suggested username, display name, and password pre-fill on every load.
        Click the regenerate icons to roll new values, or type your own. The
        new user signs in with their <strong>username</strong> + password from
        <code> /login</code>; they can change the password from{' '}
        <code>/account/password</code> after first sign-in.
      </p>

      <form action={action} className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
            Username
            <div className="relative">
              <input
                type="text"
                name="username"
                required
                pattern="^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$"
                value={identity.username}
                onChange={e =>
                  setIdentity(prev => ({ ...prev, username: e.target.value.toLowerCase() }))
                }
                placeholder="swift.heron42"
                className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 pr-9 text-[13px] font-mono text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
              />
              <button
                type="button"
                onClick={regenerateIdentity}
                aria-label="Suggest a new username + display name"
                title="Suggest a new memorable username + display name pair"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              Lowercase a–z, 0–9, dot, dash, underscore.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
            Display name (optional)
            <div className="relative">
              <input
                type="text"
                name="display_name"
                value={identity.displayName}
                onChange={e =>
                  setIdentity(prev => ({ ...prev, displayName: e.target.value }))
                }
                placeholder="Swift Heron"
                className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 pr-9 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
              />
              <button
                type="button"
                onClick={regenerateIdentity}
                aria-label="Suggest a new display name"
                title="Same regenerate as username — keeps the pair coherent"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              Shown in lists, activity log, and &quot;by &lt;name&gt;&quot; badges.
            </span>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
          Password
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              name="password"
              required
              minLength={12}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="at least 12 characters"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 pr-16 text-[13px] font-mono text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            />
            <button
              type="button"
              onClick={() => setShowPassword(s => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-9 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
            >
              {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => setPassword(suggestPassword())}
              aria-label="Suggest a new password"
              title="Suggest a new memorable password"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </label>

        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[color:var(--color-text-primary)]">
          <input
            type="checkbox"
            name="is_admin"
            checked={isAdmin}
            onChange={e => setIsAdmin(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--color-accent)]"
          />
          <span className="inline-flex items-center gap-1">
            <ShieldPlus className="h-3.5 w-3.5 text-[color:var(--color-text-secondary)]" />
            Make this user an admin (can manage other users)
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || !identity.username || password.length < 12}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 px-3 py-1.5 text-[12px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
            Create user
          </button>

          {state?.status === 'ok' && (
            <span className="inline-flex items-center gap-1 rounded-md bg-green-100 px-2 py-1 text-[11px] text-green-800">
              <CheckCircle2 className="h-3 w-3" />
              {state.message}
            </span>
          )}
          {state?.status === 'error' && (
            <span className="rounded-md bg-red-100 px-2 py-1 text-[11px] text-red-800">
              {state.error}
            </span>
          )}
        </div>
      </form>
    </section>
  )
}
