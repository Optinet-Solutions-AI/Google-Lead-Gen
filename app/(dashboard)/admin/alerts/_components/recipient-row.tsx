'use client'

import { useActionState } from 'react'
import { Globe, Loader2, Mail, Pause, Play, Trash2 } from 'lucide-react'
import {
  deleteRecipientAction,
  setRecipientActiveAction,
  type ToggleRecipientState,
} from '../actions'

const initialToggle: ToggleRecipientState = null
const initialDelete: ToggleRecipientState = null

type Props = {
  recipient: {
    id: number
    email: string
    name: string | null
    country_code: string | null
    is_active: boolean
    notes: string | null
    created_at: string
    created_by: string | null
  }
}

export function RecipientRow({ recipient }: Props) {
  const [toggleState, toggleAction, togglePending] = useActionState(
    setRecipientActiveAction,
    initialToggle,
  )
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteRecipientAction,
    initialDelete,
  )

  const errorMsg =
    toggleState?.status === 'error'
      ? toggleState.error
      : deleteState?.status === 'error'
        ? deleteState.error
        : null

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[12px]">
      <Mail
        className={[
          'h-4 w-4 shrink-0',
          recipient.is_active
            ? 'text-[color:var(--color-text-secondary)]'
            : 'text-[color:var(--color-text-secondary)]/40',
        ].join(' ')}
      />

      <div className="min-w-0 flex-1">
        <p
          className={[
            'truncate text-[12px] font-medium',
            recipient.is_active
              ? 'text-[color:var(--color-text-primary)]'
              : 'text-[color:var(--color-text-secondary)] line-through',
          ].join(' ')}
        >
          {recipient.name ? (
            <>
              {recipient.name}{' '}
              <span className="font-normal text-[color:var(--color-text-secondary)]">
                &lt;{recipient.email}&gt;
              </span>
            </>
          ) : (
            recipient.email
          )}
          {recipient.country_code ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
              <Globe className="h-2.5 w-2.5" />
              {recipient.country_code}
            </span>
          ) : (
            <span className="ml-2 rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
              all countries
            </span>
          )}
          {!recipient.is_active && (
            <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
              paused
            </span>
          )}
        </p>
        <p className="truncate text-[10px] text-[color:var(--color-text-secondary)]">
          {recipient.notes ? <span>{recipient.notes} · </span> : null}
          added {new Date(recipient.created_at).toLocaleDateString()}
          {recipient.created_by ? ` by ${recipient.created_by}` : ''}
        </p>
      </div>

      {errorMsg && (
        <span className="rounded-md bg-red-100 px-2 py-0.5 text-[10px] text-red-800">
          {errorMsg}
        </span>
      )}

      <form action={toggleAction} className="flex items-center">
        <input type="hidden" name="id" value={recipient.id} />
        <input
          type="hidden"
          name="value"
          value={recipient.is_active ? 'false' : 'true'}
        />
        <button
          type="submit"
          disabled={togglePending}
          title={recipient.is_active ? 'Pause — stop sending alerts to this recipient' : 'Resume sending alerts'}
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {togglePending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : recipient.is_active ? (
            <Pause className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {recipient.is_active ? 'Pause' : 'Resume'}
        </button>
      </form>

      <form
        action={deleteAction}
        onSubmit={e => {
          if (
            !confirm(
              `Remove ${recipient.email} from the alert list? This is permanent — past audit-log rows are kept.`,
            )
          ) {
            e.preventDefault()
          }
        }}
        className="flex items-center"
      >
        <input type="hidden" name="id" value={recipient.id} />
        <button
          type="submit"
          disabled={deletePending}
          title="Remove permanently"
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
    </div>
  )
}
