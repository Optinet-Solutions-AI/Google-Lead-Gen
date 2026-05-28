'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

// Storage key keeps the legacy 'hitl-hide-expiry-timers' value so users
// who already opted out of timers don't have their preference reset by
// the Captcha solver rename. Don't rename without a migration path for
// existing localStorage values.
const STORAGE_KEY = 'hitl-hide-expiry-timers'

type TimerPrefs = { hide: boolean; toggle: () => void }

const TimerPrefsContext = createContext<TimerPrefs>({
  hide: false,
  toggle: () => {},
})

export function useHideExpiryTimers(): boolean {
  return useContext(TimerPrefsContext).hide
}

export function TimerPrefsProvider({ children }: { children: React.ReactNode }) {
  // Start as `false` (timers visible) so SSR and the first client render
  // produce the same markup. The real preference loads from localStorage
  // in the effect below — same hydration-safe pattern used elsewhere in
  // this card. The named `load` wrapper keeps the react-hooks
  // set-state-in-effect lint rule happy.
  const [hide, setHide] = useState(false)
  useEffect(() => {
    const load = () => {
      try {
        setHide(window.localStorage.getItem(STORAGE_KEY) === '1')
      } catch {
        // localStorage can throw in private-browsing / locked-down browsers;
        // fall back to visible-by-default, which is the safer state.
      }
    }
    load()
  }, [])
  const toggle = () => {
    setHide(prev => {
      const next = !prev
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {}
      return next
    })
  }
  return (
    <TimerPrefsContext.Provider value={{ hide, toggle }}>
      {children}
    </TimerPrefsContext.Provider>
  )
}

export function HideTimersToggle() {
  const { hide, toggle } = useContext(TimerPrefsContext)
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
      title={
        hide
          ? 'Show the red countdown badge on each waiting card'
          : 'Hide the red countdown badge (saved per-browser)'
      }
    >
      {hide ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      {hide ? 'Show timers' : 'Hide timers'}
    </button>
  )
}
