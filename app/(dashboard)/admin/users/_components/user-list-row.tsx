'use client'

import { useActionState } from 'react'
import { Loader2, Shield, ShieldOff, User } from 'lucide-react'
import { setAdminFlagAction, type SetAdminState } from '../actions'

const initial: SetAdminState = null

type Props = {
  user: {
    id: string
    username: string | null
    display_name: string | null
    created_at: string
    last_sign_in_at: string | null
  }
  isAdmin: boolean
  isSelf: boolean
}

export function UserListRow({ user, isAdmin, isSelf }: Props) {
  const [state, action, pending] = useActionState(setAdminFlagAction, initial)

  // Display priority: display_name → username → fallback. Username is
  // shown as the secondary line so admins can read it out for sign-in.
  const primary = user.display_name || user.username || '(unnamed user)'
  const secondary = user.display_name && user.username ? user.username : null

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[12px]">
      <User className="h-4 w-4 shrink-0 text-[color:var(--color-text-secondary)]" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-[color:var(--color-text-primary)]">
          {primary}
          {isSelf && (
            <span className="ml-2 rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-normal text-[color:var(--color-text-secondary)]">
              you
            </span>
          )}
          {isAdmin && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
              <Shield className="h-2.5 w-2.5" />
              admin
            </span>
          )}
        </p>
        <p className="truncate text-[10px] text-[color:var(--color-text-secondary)]">
          {secondary ? <span className="font-mono">{secondary}</span> : <span className="italic">no username set</span>}
          {' · '}created {new Date(user.created_at).toLocaleDateString()}
          {user.last_sign_in_at
            ? ` · last sign-in ${new Date(user.last_sign_in_at).toLocaleString()}`
            : ' · never signed in'}
        </p>
      </div>

      <form action={action} className="flex items-center gap-1.5">
        <input type="hidden" name="user_id" value={user.id} />
        {/* The hidden value is the inverse of current — submit flips it. */}
        <input type="hidden" name="is_admin" value={isAdmin ? '' : 'on'} />
        <button
          type="submit"
          disabled={pending || (isSelf && isAdmin)}
          title={
            isSelf && isAdmin
              ? "You can't demote yourself — ask another admin"
              : isAdmin
                ? 'Remove admin'
                : 'Promote to admin'
          }
          className={[
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            isAdmin
              ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
              : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]',
          ].join(' ')}
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isAdmin ? (
            <ShieldOff className="h-3 w-3" />
          ) : (
            <Shield className="h-3 w-3" />
          )}
          {isAdmin ? 'Remove admin' : 'Make admin'}
        </button>
      </form>

      {state?.status === 'error' && (
        <span className="rounded-md bg-red-100 px-2 py-0.5 text-[10px] text-red-800">
          {state.error}
        </span>
      )}
    </div>
  )
}
