'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { Keyboard, Loader2, X } from 'lucide-react'
import { setFeedbackStatusAction } from '../actions'
import { FeedbackRow, type FeedbackRowData, type Status } from './feedback-row'

// Map keys to a status. Letters are case-sensitive on purpose so Shift+R
// can mean Rejected without colliding with `r` for Resolved.
const STATUS_KEYS: Record<string, Status> = {
  r: 'resolved',
  R: 'rejected',
  p: 'in_progress',
  o: 'open',
}

const SHORTCUTS: ReadonlyArray<{ keys: string[]; desc: string }> = [
  { keys: ['j', '↓'],  desc: 'Next row' },
  { keys: ['k', '↑'],  desc: 'Previous row' },
  { keys: ['Enter'],   desc: 'Expand / collapse row' },
  { keys: ['Esc'],     desc: 'Collapse row' },
  { keys: ['r'],       desc: 'Mark Resolved' },
  { keys: ['Shift+R'], desc: 'Mark Rejected' },
  { keys: ['p'],       desc: 'Mark In progress' },
  { keys: ['o'],       desc: 'Mark Open' },
  { keys: ['?'],       desc: 'Show this help' },
]

export function FeedbackList({ rows }: { rows: FeedbackRowData[] }) {
  const [storedFocusedId, setFocusedId] = useState<number | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [keyError, setKeyError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [, startTransition] = useTransition()
  const [keyPending, setKeyPending] = useState(false)
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // Derive the effective focused id from rows so a stale id (after tab
  // switch or revalidation drops the focused row) doesn't leave the
  // visual marker pointing at nothing. Defaults to the first row.
  const focusedId = useMemo<number | null>(() => {
    if (storedFocusedId !== null && rows.some(r => r.id === storedFocusedId)) {
      return storedFocusedId
    }
    return rows[0]?.id ?? null
  }, [rows, storedFocusedId])

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Move focus + scroll the row into view if it's not already visible.
  // Mouse-click focus skips scrolling — keyboard nav drives this path.
  const focusAndScroll = useCallback((id: number) => {
    setFocusedId(id)
    requestAnimationFrame(() => {
      const el = rowRefs.current.get(id)
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't hijack typing inside form fields or modifier combos meant
      // for the browser.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(o => !o)
        return
      }
      if (helpOpen && e.key === 'Escape') {
        e.preventDefault()
        setHelpOpen(false)
        return
      }

      if (rows.length === 0) return
      const idx = focusedId === null ? -1 : rows.findIndex(r => r.id === focusedId)

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const nextIdx = idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1)
        const next = rows[nextIdx]
        if (next) focusAndScroll(next.id)
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const prevIdx = idx <= 0 ? 0 : idx - 1
        const prev = rows[prevIdx]
        if (prev) focusAndScroll(prev.id)
        return
      }

      if (focusedId === null) return

      if (e.key === 'Enter') {
        e.preventDefault()
        toggleExpand(focusedId)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setExpandedIds(prev => {
          if (!prev.has(focusedId)) return prev
          const next = new Set(prev)
          next.delete(focusedId)
          return next
        })
        return
      }

      const targetStatus = STATUS_KEYS[e.key]
      if (targetStatus) {
        const row = rows[idx]
        if (!row || row.status === targetStatus) return
        e.preventDefault()
        const fd = new FormData()
        fd.set('id', String(focusedId))
        fd.set('status', targetStatus)
        setKeyPending(true)
        startTransition(async () => {
          const result = await setFeedbackStatusAction(null, fd)
          setKeyPending(false)
          if (result?.status === 'error') setKeyError(result.error)
          else setKeyError(null)
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedId, rows, helpOpen, focusAndScroll, toggleExpand])

  if (rows.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[12px] text-[color:var(--color-text-secondary)]">
        Nothing under this status. The QA team is doing fine — or
        isn&apos;t reporting anything.
      </p>
    )
  }

  return (
    <>
      {(keyError || keyPending) && (
        <div
          className={[
            'flex items-center gap-2 border-b border-[color:var(--color-border)] px-3 py-1.5 text-[11px]',
            keyError
              ? 'bg-red-50 text-red-800'
              : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
          ].join(' ')}
        >
          {keyPending && <Loader2 className="h-3 w-3 animate-spin" />}
          {keyError ?? 'Updating…'}
          {keyError && (
            <button
              type="button"
              onClick={() => setKeyError(null)}
              className="ml-auto rounded p-0.5 hover:bg-red-100"
              aria-label="Dismiss error"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      <div className="divide-y divide-[color:var(--color-border)]">
        {rows.map(r => (
          <div
            key={r.id}
            ref={el => {
              if (el) rowRefs.current.set(r.id, el)
              else rowRefs.current.delete(r.id)
            }}
          >
            <FeedbackRow
              row={r}
              focused={focusedId === r.id}
              expanded={expandedIds.has(r.id)}
              onToggleExpand={() => toggleExpand(r.id)}
              onFocus={() => setFocusedId(r.id)}
            />
          </div>
        ))}
      </div>

      {/* Persistent hint — small, dismissible by pressing ? to expand. */}
      <button
        type="button"
        onClick={() => setHelpOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/30 px-3 py-1.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
      >
        <Keyboard className="h-3 w-3" />
        <span>
          <kbd className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1 font-mono">j</kbd>
          {' '}/{' '}
          <kbd className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1 font-mono">k</kbd>
          {' '}navigate ·{' '}
          <kbd className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1 font-mono">r</kbd>
          {' '}resolved ·{' '}
          <kbd className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1 font-mono">?</kbd>
          {' '}all shortcuts
        </span>
      </button>

      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
    </>
  )
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-sm rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <dl className="flex flex-col gap-1.5">
          {SHORTCUTS.map(s => (
            <div key={s.desc} className="flex items-center justify-between gap-3 text-[12px]">
              <dt className="text-[color:var(--color-text-secondary)]">{s.desc}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {s.keys.map((k, i) => (
                  <kbd
                    key={i}
                    className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--color-text-primary)]"
                  >
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
