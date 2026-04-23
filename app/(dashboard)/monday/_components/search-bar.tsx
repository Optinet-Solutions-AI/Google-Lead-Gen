'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'

/**
 * Form-like search bar. Submits via router.push so the Server
 * Component re-renders with the new `?q=...` param. Preserves every
 * other query param (sort, page, etc) except `page`, which resets to
 * 1 on search.
 */
export function SearchBar() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const initial = sp.get('q') ?? ''
  const [value, setValue] = useState(initial)

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const params = new URLSearchParams(sp.toString())
    const trimmed = value.trim()
    if (trimmed) params.set('q', trimmed)
    else params.delete('q')
    params.delete('page')
    router.push(`${pathname}?${params.toString()}`)
  }

  function clear() {
    setValue('')
    const params = new URLSearchParams(sp.toString())
    params.delete('q')
    params.delete('page')
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <form onSubmit={submit} className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-text-secondary)]" />
      <input
        type="search"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Search…"
        className={[
          'w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]',
          'py-1.5 pl-8 pr-8 text-[13px] text-[color:var(--color-text-primary)]',
          'placeholder:text-[color:var(--color-text-secondary)]',
          'focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]',
        ].join(' ')}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </form>
  )
}
