'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { setMondayLabel } from '../actions'

const OPTIONS: ReadonlyArray<{
  value: 'no' | 'leads' | 'affiliate' | 'updates'
  label: string
  cls: string
}> = [
  { value: 'no', label: 'No', cls: 'bg-emerald-100 text-emerald-800' },
  { value: 'leads', label: 'Leads', cls: 'bg-amber-100 text-amber-800' },
  { value: 'affiliate', label: 'Affiliate', cls: 'bg-rose-100 text-rose-800' },
  { value: 'updates', label: 'Updates', cls: 'bg-sky-100 text-sky-800' },
]

type Props = {
  leadId: number
  isOnMonday: boolean | null
  board: string | null
  isOverridden: boolean
}

export function MondayLabelEditor({ leadId, isOnMonday, board, isOverridden }: Props) {
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

  function submit(value: string) {
    const fd = new FormData()
    fd.set('lead_id', String(leadId))
    fd.set('value', value)
    startTransition(async () => {
      await setMondayLabel(fd)
      setOpen(false)
    })
  }

  const current = badgeFor(isOnMonday, board)

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={pending}
        title={isOverridden ? 'Manually set — click to change' : 'Auto-detected — click to override'}
        className={[
          'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50',
          current.cls,
          isOverridden ? 'ring-1 ring-offset-0 ring-[color:var(--color-text-secondary)]/30' : '',
        ].join(' ')}
      >
        {current.label}
        <ChevronDown className="h-2.5 w-2.5 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[140px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 shadow-md">
          {OPTIONS.map(opt => {
            const active = (opt.value === 'no' && isOnMonday === false) ||
              (opt.value !== 'no' && isOnMonday === true && board === opt.value)
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => submit(opt.value)}
                disabled={pending}
                className={[
                  'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-50',
                  active ? 'bg-[color:var(--color-bg-secondary)]' : '',
                ].join(' ')}
              >
                <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', opt.cls].join(' ')}>
                  {opt.label}
                </span>
                {active && (
                  <span className="text-[10px] text-[color:var(--color-text-secondary)]">current</span>
                )}
              </button>
            )
          })}
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

const FALLBACK_BADGE = { label: 'On Monday', cls: 'bg-zinc-200 text-zinc-700' }

function badgeFor(isOnMonday: boolean | null, board: string | null) {
  if (isOnMonday === null) {
    return { label: '—', cls: 'bg-transparent text-[color:var(--color-text-secondary)]' }
  }
  if (isOnMonday === false) {
    return OPTIONS.find(o => o.value === 'no') ?? FALLBACK_BADGE
  }
  return OPTIONS.find(o => o.value === board) ?? FALLBACK_BADGE
}
