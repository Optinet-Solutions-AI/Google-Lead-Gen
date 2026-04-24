'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'

type ServerAction = (formData: FormData) => void | Promise<void>

type Props = {
  leadId: number
  value: boolean | null
  isOverridden: boolean
  action: ServerAction
  yesLabel?: string
  noLabel?: string
  /** When true, don't render a dropdown — just the static badge. */
  readOnly?: boolean
}

export function BooleanLabelEditor({
  leadId,
  value,
  isOverridden,
  action,
  yesLabel = 'Yes',
  noLabel = 'No',
  readOnly = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function submit(next: 'yes' | 'no' | 'clear') {
    const fd = new FormData()
    fd.set('lead_id', String(leadId))
    fd.set('value', next)
    startTransition(async () => {
      await action(fd)
      setOpen(false)
    })
  }

  const cls =
    value === true
      ? 'bg-rose-100 text-rose-800'
      : value === false
        ? 'bg-emerald-100 text-emerald-800'
        : 'bg-transparent text-[color:var(--color-text-secondary)]'
  const label = value === true ? yesLabel : value === false ? noLabel : '—'

  if (readOnly) {
    return (
      <span className={['inline-block rounded-full px-2 py-0.5 text-[10px] font-medium', cls].join(' ')}>
        {label}
      </span>
    )
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={pending}
        title={isOverridden ? 'Manually set — click to change' : 'Auto-detected — click to override'}
        className={[
          'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50',
          cls,
          isOverridden ? 'ring-1 ring-offset-0 ring-[color:var(--color-text-secondary)]/30' : '',
        ].join(' ')}
      >
        {label}
        <ChevronDown className="h-2.5 w-2.5 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[120px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 shadow-md">
          <MenuItem
            label={yesLabel}
            cls="bg-rose-100 text-rose-800"
            active={value === true}
            onClick={() => submit('yes')}
            disabled={pending}
          />
          <MenuItem
            label={noLabel}
            cls="bg-emerald-100 text-emerald-800"
            active={value === false}
            onClick={() => submit('no')}
            disabled={pending}
          />
          <div className="my-1 border-t border-[color:var(--color-border)]" />
          <button
            type="button"
            onClick={() => submit('clear')}
            disabled={pending}
            className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-[11px] text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to auto
          </button>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  label,
  cls,
  active,
  onClick,
  disabled,
}: {
  label: string
  cls: string
  active: boolean
  onClick: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-50',
        active ? 'bg-[color:var(--color-bg-secondary)]' : '',
      ].join(' ')}
    >
      <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', cls].join(' ')}>
        {label}
      </span>
      {active && (
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">current</span>
      )}
    </button>
  )
}
