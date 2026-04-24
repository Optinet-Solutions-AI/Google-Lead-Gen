'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

type Props = {
  countries: Array<{ code: string; name: string }>
}

/**
 * Two URL-driven dropdowns: country_code + result_type.
 * Empty value = "All". Changing either resets ?page= to 1.
 */
export function LeadsFilters({ countries }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  const currentCountry = sp.get('country_code') ?? ''
  const currentType = sp.get('result_type') ?? ''

  function update(key: 'country_code' | 'result_type', value: string) {
    const params = new URLSearchParams(sp.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    params.delete('page')
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-text-secondary)]">
        Country
        <select
          value={currentCountry}
          onChange={e => update('country_code', e.target.value)}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
        >
          <option value="">All</option>
          {countries.map(c => (
            <option key={c.code} value={c.code}>
              {c.name} ({c.code})
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-text-secondary)]">
        Type
        <select
          value={currentType}
          onChange={e => update('result_type', e.target.value)}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
        >
          <option value="">All</option>
          <option value="Organic">Organic</option>
          <option value="PPC">PPC</option>
        </select>
      </label>
    </div>
  )
}
