'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { Filter, ListChecks } from 'lucide-react'

// Per-browser preference for hiding lead-site (enrichment) checkpoints
// so operators can focus on search-engine captchas only.
const STORAGE_KEY = 'hitl-scrape-only'

type ScrapeOnlyPrefs = { scrapeOnly: boolean; toggle: () => void }

const ScrapeOnlyPrefsContext = createContext<ScrapeOnlyPrefs>({
  scrapeOnly: true,
  toggle: () => {},
})

export function useScrapeOnly(): boolean {
  return useContext(ScrapeOnlyPrefsContext).scrapeOnly
}

/**
 * Default: scrape-only = true. Lead-site captchas (cookie banners on
 * casino sites, etc.) are hidden unless the operator explicitly asks
 * to see them. Overridable via the toggle; persists per-browser.
 */
export function ScrapeOnlyPrefsProvider({ children }: { children: React.ReactNode }) {
  // Start `true` (scrape-only ON) so SSR and first client render match.
  // Real value loads from localStorage in the effect below.
  const [scrapeOnly, setScrapeOnly] = useState(true)
  useEffect(() => {
    const load = () => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        // Explicit '0' turns it off; anything else (missing, '1') stays ON.
        setScrapeOnly(raw !== '0')
      } catch {
        /* private browsing / locked storage — keep default */
      }
    }
    load()
  }, [])
  const toggle = () => {
    setScrapeOnly(prev => {
      const next = !prev
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {}
      return next
    })
  }
  return (
    <ScrapeOnlyPrefsContext.Provider value={{ scrapeOnly, toggle }}>
      {children}
    </ScrapeOnlyPrefsContext.Provider>
  )
}

export function ScrapeOnlyToggle() {
  const { scrapeOnly, toggle } = useContext(ScrapeOnlyPrefsContext)
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
      title={
        scrapeOnly
          ? 'Currently hiding lead-site (enrichment) captchas. Click to see all.'
          : 'Currently showing all captchas. Click to hide lead-site (enrichment) ones.'
      }
    >
      {scrapeOnly ? <Filter className="h-3 w-3" /> : <ListChecks className="h-3 w-3" />}
      {scrapeOnly ? 'Scrape-only' : 'Show all'}
    </button>
  )
}
