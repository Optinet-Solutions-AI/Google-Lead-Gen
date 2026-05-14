'use client'

import { useActionState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Mail,
  Trash2,
  User,
  XCircle,
} from 'lucide-react'
import {
  deleteFeedbackAction,
  setFeedbackStatusAction,
  type FeedbackMutationState,
} from '../actions'

const initialMut: FeedbackMutationState = null

export type Status = 'open' | 'in_progress' | 'resolved' | 'rejected'

export type FeedbackRowData = {
  id: number
  user_id: string | null
  user_display: string | null
  user_email: string | null
  url: string | null
  message: string
  status: Status
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

const STATUS_OPTIONS: ReadonlyArray<{ key: Status; label: string }> = [
  { key: 'open',        label: 'Open' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'resolved',    label: 'Resolved' },
  { key: 'rejected',    label: 'Rejected' },
]

const STATUS_STYLES: Record<Status, string> = {
  open:        'bg-amber-100 text-amber-800',
  in_progress: 'bg-sky-100 text-sky-800',
  resolved:    'bg-emerald-100 text-emerald-800',
  rejected:    'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] line-through',
}

type Props = {
  row: FeedbackRowData
  focused: boolean
  expanded: boolean
  onToggleExpand: () => void
  onFocus: () => void
}

export function FeedbackRow({ row, focused, expanded, onToggleExpand, onFocus }: Props) {
  const [statusState, statusAction, statusPending] = useActionState(
    setFeedbackStatusAction,
    initialMut,
  )
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteFeedbackAction,
    initialMut,
  )

  const errorMsg =
    statusState?.status === 'error'
      ? statusState.error
      : deleteState?.status === 'error'
        ? deleteState.error
        : null

  const created = new Date(row.created_at).toLocaleString()
  const messagePreview = row.message.length > 110
    ? row.message.slice(0, 110) + '…'
    : row.message

  return (
    <div
      onClick={onFocus}
      className={[
        'flex cursor-pointer flex-col gap-2 border-l-2 px-3 py-3 text-[12px] transition-colors',
        focused
          ? 'border-l-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5'
          : 'border-l-transparent hover:bg-[color:var(--color-bg-secondary)]/40',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start gap-3">
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            onToggleExpand()
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-[color:var(--color-text-primary)]">
            {expanded ? row.message : messagePreview}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[color:var(--color-text-secondary)]">
            <span className="inline-flex items-center gap-1">
              <User className="h-2.5 w-2.5" />
              {row.user_display ?? row.user_email ?? 'Unknown user'}
            </span>
            <span>·</span>
            <span>{created}</span>
            {row.resolved_at && (
              <>
                <span>·</span>
                <span>
                  resolved {new Date(row.resolved_at).toLocaleDateString()}
                  {row.resolved_by ? ` by ${row.resolved_by}` : ''}
                </span>
              </>
            )}
          </div>

          {row.url && (
            <a
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-[11px] text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900 hover:decoration-sky-500"
              title={row.url}
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{row.url}</span>
            </a>
          )}
        </div>

        <span
          className={[
            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            STATUS_STYLES[row.status],
          ].join(' ')}
        >
          {row.status === 'in_progress' ? 'in progress' : row.status}
        </span>
      </div>

      {expanded && (
        <div
          onClick={e => e.stopPropagation()}
          className="ml-8 flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/40 p-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              Status:
            </span>
            {STATUS_OPTIONS.map(opt => {
              const active = row.status === opt.key
              return (
                <form key={opt.key} action={statusAction}>
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="status" value={opt.key} />
                  <button
                    type="submit"
                    disabled={active || statusPending}
                    className={[
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      active
                        ? `${STATUS_STYLES[opt.key]} border-transparent`
                        : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
                    ].join(' ')}
                    title={`Mark as ${opt.label}`}
                  >
                    {statusPending && !active ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : opt.key === 'resolved' ? (
                      <CheckCircle2 className="h-2.5 w-2.5" />
                    ) : opt.key === 'rejected' ? (
                      <XCircle className="h-2.5 w-2.5" />
                    ) : null}
                    {opt.label}
                  </button>
                </form>
              )
            })}

            {row.user_email && (
              <a
                href={`mailto:${row.user_email}`}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                title={`Email ${row.user_email}`}
              >
                <Mail className="h-2.5 w-2.5" />
                Email reporter
              </a>
            )}

            <form
              action={deleteAction}
              onSubmit={e => {
                if (!confirm('Delete this feedback row? Permanent.')) {
                  e.preventDefault()
                }
              }}
            >
              <input type="hidden" name="id" value={row.id} />
              <button
                type="submit"
                disabled={deletePending}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
              >
                {deletePending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Trash2 className="h-2.5 w-2.5" />}
                Delete
              </button>
            </form>
          </div>

          {errorMsg && (
            <p className="rounded-md bg-red-100 px-2 py-1 text-[10px] text-red-800">
              {errorMsg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
