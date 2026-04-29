'use client'

import { useActionState, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mail,
  Search,
  Tag,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import {
  deleteLeads,
  retryEnrichmentForLeads,
  type BulkActionState,
} from '../actions'

const initial: BulkActionState = null

type Props = {
  selectedIds: number[]
  onClear: () => void
}

export function BulkActionsBar({ selectedIds, onClear }: Props) {
  const idCsv = selectedIds.join(',')
  const [retryState, retryAction, retryPending] = useActionState(
    retryEnrichmentForLeads,
    initial,
  )
  const [showDelete, setShowDelete] = useState(false)
  const lastMessage = retryState
  const expectedConfirm = `delete ${selectedIds.length}`

  return (
    <div className="sticky top-3 z-30 flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 shadow-md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-[color:var(--color-accent)]/20 px-2 py-0.5 text-[11px] font-semibold text-[color:var(--color-text-primary)]">
          {selectedIds.length} selected
        </span>

        <span className="text-[11px] text-[color:var(--color-text-secondary)]">
          Retry stage:
        </span>

        <RetryButton
          stage="affiliate"
          idCsv={idCsv}
          icon={<Search className="h-3 w-3" />}
          action={retryAction}
          pending={retryPending}
        >
          Affiliate
        </RetryButton>
        <RetryButton
          stage="rooster"
          idCsv={idCsv}
          icon={<CheckCircle2 className="h-3 w-3" />}
          action={retryAction}
          pending={retryPending}
        >
          Rooster
        </RetryButton>
        <RetryButton
          stage="contact"
          idCsv={idCsv}
          icon={<Mail className="h-3 w-3" />}
          action={retryAction}
          pending={retryPending}
        >
          Contact
        </RetryButton>
        <RetryButton
          stage="stag"
          idCsv={idCsv}
          icon={<Tag className="h-3 w-3" />}
          action={retryAction}
          pending={retryPending}
        >
          S-tags
        </RetryButton>

        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDelete(s => !s)}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-100"
          >
            <Trash2 className="h-3 w-3" />
            Delete selected
          </button>
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
            title="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {showDelete && (
        <DeletePanel
          idCsv={idCsv}
          expectedConfirm={expectedConfirm}
          onCancel={() => setShowDelete(false)}
          onSuccess={onClear}
        />
      )}

      {lastMessage && (
        <p
          className={[
            'rounded-md px-2 py-1 text-[11px]',
            lastMessage.status === 'ok'
              ? 'bg-green-100 text-green-800'
              : 'bg-red-100 text-red-800',
          ].join(' ')}
        >
          {lastMessage.status === 'ok' ? lastMessage.message : lastMessage.error}
        </p>
      )}
    </div>
  )
}

function RetryButton({
  stage,
  idCsv,
  icon,
  children,
  action,
  pending,
}: {
  stage: 'affiliate' | 'rooster' | 'contact' | 'stag'
  idCsv: string
  icon: React.ReactNode
  children: React.ReactNode
  action: (fd: FormData) => void
  pending: boolean
}) {
  return (
    <form action={action}>
      <input type="hidden" name="lead_ids" value={idCsv} />
      <input type="hidden" name="stage" value={stage} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
        {children}
      </button>
    </form>
  )
}

function DeletePanel({
  idCsv,
  expectedConfirm,
  onCancel,
  onSuccess,
}: {
  idCsv: string
  expectedConfirm: string
  onCancel: () => void
  onSuccess: () => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const matches = confirmation === expectedConfirm
  const [delState, delAction, delPending] = useActionState(deleteLeads, initial)
  if (delState?.status === 'ok') queueMicrotask(onSuccess)

  return (
    <div className="rounded-md border border-red-200 bg-red-50/60 p-2.5">
      <div className="flex items-center gap-1.5 text-red-800">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="text-[11px] font-semibold">
          Type <span className="font-mono">{expectedConfirm}</span> below to confirm.
          This wipes the selected leads, their s-tags, screenshots, and enrichment data.
        </span>
      </div>
      <form action={delAction} className="mt-2 flex flex-wrap gap-2">
        <input type="hidden" name="lead_ids" value={idCsv} />
        <input type="hidden" name="confirmation_text" value={confirmation} />
        <input
          type="text"
          value={confirmation}
          onChange={e => setConfirmation(e.target.value)}
          placeholder={expectedConfirm}
          className="grow rounded-md border border-red-300 bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[12px] focus:border-red-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!matches || delPending}
          className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-100 px-2.5 py-1 text-[11px] font-semibold text-red-900 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {delPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Users className="h-3 w-3" />}
          Delete {idCsv.split(',').length}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] hover:bg-[color:var(--color-bg-secondary)]"
        >
          Cancel
        </button>
      </form>
      {delState?.status === 'error' && (
        <p className="mt-1.5 rounded-md bg-red-100 px-2 py-1 text-[11px] text-red-800">
          {delState.error}
        </p>
      )}
    </div>
  )
}
