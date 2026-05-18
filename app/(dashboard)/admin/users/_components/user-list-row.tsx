'use client'

import { useActionState, useState } from 'react'
import { CheckCircle2, Hash, Loader2, Shield, ShieldOff, Trash2, User } from 'lucide-react'
import {
  deleteUserAction,
  setAdminFlagAction,
  setMondayUserIdAction,
  type DeleteUserState,
  type SetAdminState,
  type SetMondayUserIdState,
} from '../actions'

const initial: SetAdminState = null
const initialMondayId: SetMondayUserIdState = null
const initialDelete: DeleteUserState = null

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
  /** Monday.com user ID this user maps to. Owner column on every
   *  Push-to-Monday item gets stamped with this. Null = falls back
   *  to the legacy default owner. */
  mondayUserId: number | null
}

export function UserListRow({ user, isAdmin, isSelf, mondayUserId }: Props) {
  const [state, action, pending] = useActionState(setAdminFlagAction, initial)
  const [mondayState, mondayAction, mondayPending] = useActionState(
    setMondayUserIdAction,
    initialMondayId,
  )
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteUserAction,
    initialDelete,
  )
  const [mondayInput, setMondayInput] = useState(
    mondayUserId === null ? '' : String(mondayUserId),
  )

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
        <p
          className="truncate text-[10px] text-[color:var(--color-text-secondary)]"
          // Locale-formatted timestamps differ between Node's en-US SSR
          // and the browser's locale. See BUGS.md R2-20.
          suppressHydrationWarning
        >
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

      <form action={mondayAction} className="flex items-center gap-1.5">
        <input type="hidden" name="user_id" value={user.id} />
        <label
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1.5 text-[11px] focus-within:border-[color:var(--color-accent)]"
          title="Monday.com user ID — Push-to-Monday stamps this as the Owner. Leave blank to fall back to the default owner."
        >
          <Hash className="h-2.5 w-2.5 text-[color:var(--color-text-secondary)]" />
          <input
            type="text"
            inputMode="numeric"
            name="monday_user_id"
            value={mondayInput}
            onChange={e => setMondayInput(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="Monday ID"
            className="w-24 bg-transparent py-1 text-[11px] text-[color:var(--color-text-primary)] focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={mondayPending || mondayInput === (mondayUserId === null ? '' : String(mondayUserId))}
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {mondayPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          Save
        </button>
      </form>

      <form
        action={deleteAction}
        onSubmit={e => {
          if (
            !confirm(
              `Permanently delete ${primary}? Their auth row and profile are removed; activity-log entries are kept for audit.`,
            )
          ) {
            e.preventDefault()
          }
        }}
        className="flex items-center"
      >
        <input type="hidden" name="user_id" value={user.id} />
        <button
          type="submit"
          disabled={deletePending || isSelf}
          title={isSelf ? "You can't delete yourself" : 'Delete user permanently'}
          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {deletePending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
          Delete
        </button>
      </form>

      {state?.status === 'error' && (
        <span className="rounded-md bg-red-100 px-2 py-0.5 text-[10px] text-red-800">
          {state.error}
        </span>
      )}
      {mondayState?.status === 'error' && (
        <span className="rounded-md bg-red-100 px-2 py-0.5 text-[10px] text-red-800">
          {mondayState.error}
        </span>
      )}
      {mondayState?.status === 'ok' && (
        <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800">
          {mondayState.message}
        </span>
      )}
      {deleteState?.status === 'error' && (
        <span className="rounded-md bg-red-100 px-2 py-0.5 text-[10px] text-red-800">
          {deleteState.error}
        </span>
      )}
    </div>
  )
}
