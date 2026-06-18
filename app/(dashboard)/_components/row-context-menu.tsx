'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * Reusable right-click context menu for table rows.
 *
 * Lives in a React portal at the document body so a row's
 * overflow:hidden / position:relative ancestor can't clip it. Closes
 * on click-outside, Escape, scroll, or after the operator picks an
 * action.
 *
 * Tables that want this:
 *   1. Track `cursor: { x, y } | null` in component state.
 *   2. On each <tr>, handle onContextMenu to setCursor({ x, y }) +
 *      preventDefault, plus optionally update the selection if the
 *      right-clicked row isn't part of it.
 *   3. On row click with ctrlKey/metaKey, toggle the row's id in the
 *      multi-select set.
 *   4. Render <RowContextMenu cursor={cursor} actions={…}
 *      onClose={() => setCursor(null)} /> at the table root.
 */
export type ContextMenuAction = {
  label: string
  /** Lucide icon component to render to the left of the label. */
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  /** When set, action is rendered greyed-out and the click is a no-op. */
  disabled?: boolean | undefined
  /** Subtitle below the label — useful for "N selected" hints. */
  hint?: string | undefined
  /** Bold danger styling — used for "Delete N rows" etc. */
  destructive?: boolean | undefined
  /** Visually separates the action from the next one below. */
  separatorAfter?: boolean | undefined
}

type Props = {
  /** Viewport-relative cursor coordinates. Null hides the menu. */
  cursor: { x: number; y: number } | null
  actions: ContextMenuAction[]
  onClose: () => void
}

const MENU_WIDTH = 240
const MENU_VERTICAL_MARGIN = 8

export function RowContextMenu({ cursor, actions, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!cursor) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = () => onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // Capture-true so we also close on scrolls happening inside any
    // scrollable ancestor of the row, not just the document.
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [cursor, onClose])

  if (!cursor) return null
  // Don't render on server — `document` access in createPortal would
  // throw and the menu only matters once mounted in the browser.
  if (typeof document === 'undefined') return null

  // Clamp to viewport so opening near the right/bottom edge doesn't
  // produce a clipped menu. We don't know the menu height before
  // render — assume ~50px per action as a reasonable upper bound.
  const approxHeight = actions.length * 40 + 12
  const maxX = window.innerWidth - MENU_WIDTH - 4
  const maxY = window.innerHeight - approxHeight - MENU_VERTICAL_MARGIN
  const x = Math.min(cursor.x, Math.max(4, maxX))
  const y = Math.min(cursor.y, Math.max(4, maxY))

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        width: MENU_WIDTH,
        zIndex: 60,
      }}
      className="rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-primary)] py-1 text-[12px] shadow-xl"
    >
      {actions.map((action, i) => {
        const Icon = action.icon
        const cls = [
          'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors',
          action.disabled
            ? 'cursor-not-allowed text-[color:var(--color-text-secondary)]/50'
            : action.destructive
              ? 'cursor-pointer text-red-700 hover:bg-red-50'
              : 'cursor-pointer text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]',
        ].join(' ')
        return (
          <div key={`${action.label}-${i}`}>
            <button
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                if (action.disabled) return
                action.onClick()
                onClose()
              }}
              className={cls}
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{action.label}</span>
                {action.hint && (
                  <span className="truncate text-[10px] text-[color:var(--color-text-secondary)]">
                    {action.hint}
                  </span>
                )}
              </span>
            </button>
            {action.separatorAfter && (
              <div className="my-1 h-px bg-[color:var(--color-border)]" />
            )}
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
