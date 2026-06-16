'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * Datetime picker for the /admin/operations "Since…" window.
 *
 * The picker is client-side because `<input type="datetime-local">`
 * works in the browser's local clock, but the URL query parameter
 * that drives the server query needs UTC ISO. The conversion can't
 * happen on the server — the server doesn't know the operator's
 * timezone — so we do it here on submit and then push the resolved
 * URL with router.push.
 *
 * Props:
 *   defaultIso — current window-start in UTC ISO (e.g. month-start).
 *                We render the corresponding LOCAL clock value in
 *                the picker.
 */
export function SincePicker({ defaultIso }: { defaultIso: string }) {
  const router = useRouter()
  const [localValue, setLocalValue] = useState('')

  useEffect(() => {
    setLocalValue(isoToLocalInputValue(defaultIso))
  }, [defaultIso])

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!localValue) {
      router.push('/admin/operations')
      return
    }
    // Browser parses the bare local string in its own clock; converting
    // to ISO yields UTC, which is what the server query expects.
    const localDate = new Date(localValue)
    if (Number.isNaN(localDate.getTime())) {
      router.push('/admin/operations')
      return
    }
    const utcIso = localDate.toISOString()
    router.push(`/admin/operations?since=${encodeURIComponent(utcIso)}`)
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <input
        type="datetime-local"
        value={localValue}
        onChange={e => setLocalValue(e.target.value)}
        className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
      />
      <button
        type="submit"
        className="rounded-md bg-[color:var(--color-accent)] px-3 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)]"
      >
        Apply
      </button>
      <a
        href="/admin/operations"
        className="rounded-md border border-[color:var(--color-border)] px-3 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
      >
        Reset
      </a>
    </form>
  )
}

/** Convert a UTC ISO into the bare "YYYY-MM-DDTHH:mm" the local
 *  picker expects, using the browser's local clock for the
 *  components. */
function isoToLocalInputValue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
