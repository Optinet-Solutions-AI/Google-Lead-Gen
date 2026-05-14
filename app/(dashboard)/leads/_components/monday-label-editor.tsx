'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { setMondayLabel, type MondayLabelValue } from '../actions'
import { invalidateLeadDetailCache } from '../_lib/detail-cache'

type CategoryKey =
  | 'no'
  | 'affiliates'
  | 'affiliates_updates'
  | 'leads'
  | 'leads_updates'
  | 'not_relevant_leads'
  | 'not_relevant_leads_updates'
  | 'email_undelivered_leads'
  | 'email_undelivered_leads_updates'

type CategoryMeta = { label: string; cls: string }

export const CATEGORY_META: Record<CategoryKey, CategoryMeta> = {
  no:                              { label: 'No',                          cls: 'bg-emerald-100 text-emerald-800' },
  affiliates:                      { label: 'Affiliates',                  cls: 'bg-rose-100 text-rose-800' },
  affiliates_updates:              { label: 'Affiliates updates',          cls: 'bg-rose-50 text-rose-700' },
  leads:                           { label: 'Leads',                       cls: 'bg-amber-100 text-amber-800' },
  leads_updates:                   { label: 'Leads updates',               cls: 'bg-amber-50 text-amber-700' },
  not_relevant_leads:              { label: 'Not relevant',                cls: 'bg-zinc-200 text-zinc-700' },
  not_relevant_leads_updates:      { label: 'Not relevant updates',        cls: 'bg-zinc-100 text-zinc-600' },
  email_undelivered_leads:         { label: 'Email undelivered',           cls: 'bg-sky-100 text-sky-800' },
  email_undelivered_leads_updates: { label: 'Email undelivered updates',   cls: 'bg-sky-50 text-sky-700' },
}

const ITEM_CATEGORIES: CategoryKey[] = [
  'affiliates',
  'leads',
  'not_relevant_leads',
  'email_undelivered_leads',
]

const UPDATE_CATEGORIES: CategoryKey[] = [
  'affiliates_updates',
  'leads_updates',
  'not_relevant_leads_updates',
  'email_undelivered_leads_updates',
]

const FALLBACK_BADGE: CategoryMeta = { label: 'On Monday', cls: 'bg-zinc-200 text-zinc-700' }

type Props = {
  leadId: number
  isOnMonday: boolean | null
  board: string | null
  isOverridden: boolean
}

export function MondayLabelEditor({ leadId, isOnMonday, board, isOverridden }: Props) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setError(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setError(null)
      triggerRef.current?.focus()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = panelRef.current?.querySelectorAll<HTMLButtonElement>('button')
      if (!items || items.length === 0) return
      const list = Array.from(items)
      const current = list.indexOf(document.activeElement as HTMLButtonElement)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      let next = current + delta
      if (next < 0) next = list.length - 1
      if (next >= list.length) next = 0
      e.preventDefault()
      list[next]?.focus()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      setError(null)
    }
  }

  function submit(value: MondayLabelValue) {
    const fd = new FormData()
    fd.set('lead_id', String(leadId))
    fd.set('value', value)
    setError(null)
    startTransition(async () => {
      try {
        await setMondayLabel(fd)
        invalidateLeadDetailCache(leadId)
        setOpen(false)
      } catch (e) {
        // Keep menu open so the user can retry without re-clicking the badge.
        setError(e instanceof Error ? e.message : 'Failed to update label.')
      }
    })
  }

  const current = badgeFor(isOnMonday, board)
  const currentValue: CategoryKey | 'unset' =
    isOnMonday === null ? 'unset' : isOnMonday === false ? 'no' : (board as CategoryKey | null) ?? 'unset'

  return (
    <div ref={ref} className="relative inline-block" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={pending}
        aria-haspopup="menu"
        aria-expanded={open}
        title={isOverridden ? 'Manually set — click to change' : 'Auto-detected — click to override'}
        className={[
          'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
          current.cls,
          isOverridden ? 'ring-1 ring-offset-0 ring-[color:var(--color-text-secondary)]/30' : '',
        ].join(' ')}
      >
        {current.label}
        <ChevronDown className="h-2.5 w-2.5 opacity-60" />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 min-w-[220px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 shadow-md"
        >
          <MenuItem
            value="no"
            currentValue={currentValue}
            onClick={() => submit('no')}
            disabled={pending}
          />
          <SectionLabel>Items</SectionLabel>
          {ITEM_CATEGORIES.map(c => (
            <MenuItem
              key={c}
              value={c}
              currentValue={currentValue}
              onClick={() => submit(c)}
              disabled={pending}
            />
          ))}
          <SectionLabel>Updates (mention in body text)</SectionLabel>
          {UPDATE_CATEGORIES.map(c => (
            <MenuItem
              key={c}
              value={c}
              currentValue={currentValue}
              onClick={() => submit(c)}
              disabled={pending}
            />
          ))}
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
          {error && (
            <p className="mx-1 mt-1 rounded-sm bg-rose-50 px-2 py-1 text-[10px] text-rose-700">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  value,
  currentValue,
  onClick,
  disabled,
}: {
  value: CategoryKey
  currentValue: CategoryKey | 'unset'
  onClick: () => void
  disabled: boolean
}) {
  const meta = CATEGORY_META[value]
  const active = value === currentValue
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
      <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', meta.cls].join(' ')}>
        {meta.label}
      </span>
      {active && (
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">current</span>
      )}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
      {children}
    </p>
  )
}

function badgeFor(isOnMonday: boolean | null, board: string | null): CategoryMeta {
  if (isOnMonday === null) {
    return { label: '—', cls: 'bg-transparent text-[color:var(--color-text-secondary)]' }
  }
  if (isOnMonday === false) return CATEGORY_META.no
  if (board && board in CATEGORY_META) return CATEGORY_META[board as CategoryKey]
  return FALLBACK_BADGE
}
