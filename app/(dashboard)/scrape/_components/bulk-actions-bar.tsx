'use client'

import { useActionState, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import {
  bulkDeleteScrapeJobs,
  bulkRerunScrapeJobs,
  type BulkScrapeActionState,
} from '../actions'

const initial: BulkScrapeActionState = null

type Props = {
  selectedIds: string[]
  onClear: () => void
}

export function BulkScrapeActionsBar({ selectedIds, onClear }: Props) {
  const idCsv = selectedIds.join(',')
  const [rerunState, rerunAction, rerunPending] = useActionState(
    bulkRerunScrapeJobs,
    initial,
  )
  const [showDelete, setShowDelete] = useState(false)
  const expectedConfirm = `delete ${selectedIds.length}`

  return (
    <div className="sticky top-3 z-30 flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 shadow-md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-[color:var(--color-accent)]/20 px-2 py-0.5 text-[11px] font-semibold text-[color:var(--color-text-primary)]">
          {selectedIds.length} job{selectedIds.length === 1 ? '' : 's'} selected
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
          <ShieldAlert className="h-2.5 w-2.5" />
          admin
        </span>

        <form action={rerunAction}>
          <input type="hidden" name="job_ids" value={idCsv} />
          <button
            type="submit"
            disabled={rerunPending}
            title="Queue a fresh scrape for each selected job (same keyword/country/pages). Useful when a batch failed quickly and you want to retry them all."
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {rerunPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Re-run selected
          </button>
        </form>

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
          onSuccess={() => {
            setShowDelete(false)
            onClear()
          }}
        />
      )}

      {rerunState && (
        <p
          className={[
            'rounded-md px-2 py-1 text-[11px]',
            rerunState.status === 'ok'
              ? 'bg-green-100 text-green-800'
              : 'bg-red-100 text-red-800',
          ].join(' ')}
        >
          {rerunState.status === 'ok' ? rerunState.message : rerunState.error}
        </p>
      )}
    </div>
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
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [delState, delAction, delPending] = useActionState(bulkDeleteScrapeJobs, initial)
  const matches = confirmation === expectedConfirm
  const ready = matches && password.length > 0
  useEffect(() => {
    if (delState?.status === 'ok') onSuccess()
  }, [delState, onSuccess])

  const count = idCsv.split(',').length

  return (
    <div className="rounded-md border border-red-200 bg-red-50/60 p-2.5">
      <div className="flex items-start gap-1.5 text-red-800">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="text-[11px] font-semibold">
          You&apos;re about to permanently wipe {count} scrape{count === 1 ? '' : 's'}
          {' '}— including every lead, screenshot, contact, and s-tag they
          produced. This cannot be undone. Two confirmations required.
        </span>
      </div>
      <form action={delAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="job_ids" value={idCsv} />
        <input type="hidden" name="confirmation_text" value={confirmation} />
        <input type="hidden" name="admin_password" value={password} />

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-red-900/80">
            Type <span className="font-mono normal-case">{expectedConfirm}</span> to confirm
          </label>
          <input
            type="text"
            value={confirmation}
            onChange={e => setConfirmation(e.target.value)}
            placeholder={expectedConfirm}
            autoComplete="off"
            className="rounded-md border border-red-300 bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[12px] focus:border-red-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-red-900/80">
            Re-enter your admin password
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full rounded-md border border-red-300 bg-[color:var(--color-bg-primary)] px-2.5 py-1 pr-8 text-[12px] focus:border-red-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword(s => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            >
              {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={!ready || delPending}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-100 px-2.5 py-1 text-[11px] font-semibold text-red-900 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {delPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Delete {count}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] hover:bg-[color:var(--color-bg-secondary)]"
          >
            Cancel
          </button>
        </div>
      </form>
      {delState?.status === 'error' && (
        <p className="mt-1.5 rounded-md bg-red-100 px-2 py-1 text-[11px] text-red-800">
          {delState.error}
        </p>
      )}
    </div>
  )
}
