'use client'

import { useState, useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import {
  deleteRoosterBrand,
  setRoosterBrandActive,
  updateRoosterBrandName,
  updateRoosterBrandNotes,
} from '../actions'

export type BrandRow = {
  id: number
  domain: string
  brand_name: string | null
  notes: string | null
  is_active: boolean
  updated_at: string
}

export function BrandRowEditor({ brand }: { brand: BrandRow }) {
  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-b-0">
      <Td>
        <span className="font-medium text-[color:var(--color-text-primary)]">{brand.domain}</span>
      </Td>
      <Td className="min-w-[220px]">
        <NameField id={brand.id} initial={brand.brand_name} />
      </Td>
      <Td>
        <ActiveToggle id={brand.id} value={brand.is_active} />
      </Td>
      <Td className="min-w-[260px]">
        <NotesField id={brand.id} initial={brand.notes} />
      </Td>
      <Td>
        <DeleteButton id={brand.id} domain={brand.domain} />
      </Td>
    </tr>
  )
}

function ActiveToggle({ id, value }: { id: number; value: boolean }) {
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState<'idle' | 'error'>('idle')
  function flip() {
    const fd = new FormData()
    fd.set('id', String(id))
    fd.set('value', value ? 'false' : 'true')
    startTransition(async () => {
      try {
        await setRoosterBrandActive(fd)
        setSaved('idle')
      } catch {
        setSaved('error')
        setTimeout(() => setSaved('idle'), 2500)
      }
    })
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={flip}
        disabled={pending}
        className={[
          'inline-block rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50',
          value ? 'bg-emerald-100 text-emerald-800' : 'bg-zinc-200 text-zinc-700',
        ].join(' ')}
      >
        {value ? 'Active' : 'Disabled'}
      </button>
      {saved === 'error' && <span className="text-[10px] text-red-700">err</span>}
    </div>
  )
}

function NameField({ id, initial }: { id: number; initial: string | null }) {
  const [value, setValue] = useState(initial ?? '')
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState<'idle' | 'ok' | 'error'>('idle')

  function save() {
    // Compare trimmed — the server action trims on receipt, so a user
    // tab-out after typing a stray leading/trailing space was sending
    // a server write even when the effective value was identical
    // (logging an activity_log row + revalidating /brands every time).
    // See BUGS.md R2-36.
    if (value.trim() === (initial ?? '').trim()) return
    const fd = new FormData()
    fd.set('id', String(id))
    fd.set('brand_name', value)
    startTransition(async () => {
      try {
        await updateRoosterBrandName(fd)
        setSaved('ok')
        setTimeout(() => setSaved('idle'), 1500)
      } catch {
        setSaved('error')
        setTimeout(() => setSaved('idle'), 2500)
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        placeholder="Brand display name"
        disabled={pending}
        className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      {saved === 'ok' && <span className="text-[10px] text-emerald-700">saved</span>}
      {saved === 'error' && <span className="text-[10px] text-red-700">err</span>}
    </div>
  )
}

function NotesField({ id, initial }: { id: number; initial: string | null }) {
  const [value, setValue] = useState(initial ?? '')
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState<'idle' | 'ok' | 'error'>('idle')

  function save() {
    // Trim before compare — see NameField above for context (R2-36).
    if (value.trim() === (initial ?? '').trim()) return
    const fd = new FormData()
    fd.set('id', String(id))
    fd.set('notes', value)
    startTransition(async () => {
      try {
        await updateRoosterBrandNotes(fd)
        setSaved('ok')
        setTimeout(() => setSaved('idle'), 1500)
      } catch {
        setSaved('error')
        setTimeout(() => setSaved('idle'), 2500)
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        placeholder="(optional)"
        disabled={pending}
        className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      {saved === 'ok' && <span className="text-[10px] text-emerald-700">saved</span>}
      {saved === 'error' && <span className="text-[10px] text-red-700">err</span>}
    </div>
  )
}

function DeleteButton({ id, domain }: { id: number; domain: string }) {
  const [pending, startTransition] = useTransition()
  function onClick() {
    if (!confirm(`Delete brand "${domain}"? Future Rooster checks will no longer match it.`)) return
    const fd = new FormData()
    fd.set('id', String(id))
    startTransition(async () => {
      try {
        await deleteRoosterBrand(fd)
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e))
      }
    })
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title="Delete"
      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
    >
      <Trash2 className="h-3 w-3" />
      {pending ? '...' : 'Delete'}
    </button>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={['whitespace-nowrap px-3 py-2 align-middle text-[12px]', className ?? ''].join(' ')}>
      {children}
    </td>
  )
}
