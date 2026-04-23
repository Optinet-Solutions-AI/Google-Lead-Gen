'use client'

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type UIEvent,
} from 'react'

type Props = {
  children: ReactNode
  className?: string
}

/**
 * Wraps a horizontally-scrollable element (our table) with:
 *   - A mirror scrollbar at the top, so the user can scroll from the
 *     top edge without dragging the content down to the bottom one.
 *   - Drag-to-scroll: mousedown + drag anywhere in the table (headers
 *     or rows) pans horizontally. Clicks still fall through to
 *     sortable headers unless the user actually dragged (>3 px moved).
 *
 * Scroll events sync both directions via a tiny rAF guard so changes
 * don't ping-pong between the two containers.
 */
export function ScrollSync({ children, className }: Props) {
  const topRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const [contentWidth, setContentWidth] = useState(0)

  const dragState = useRef<{ startX: number; startScroll: number } | null>(null)
  const movedRef = useRef(false)
  const syncGuard = useRef<'top' | 'main' | null>(null)

  // Track the table's scrollWidth so the top mirror knows how wide
  // to pretend to be. ResizeObserver on the main container + its first
  // child covers both layout changes and content changes.
  useEffect(() => {
    if (!mainRef.current) return
    const el = mainRef.current
    const update = () => setContentWidth(el.scrollWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])

  function onTopScroll(e: UIEvent<HTMLDivElement>) {
    if (syncGuard.current === 'main') return
    syncGuard.current = 'top'
    if (mainRef.current) mainRef.current.scrollLeft = e.currentTarget.scrollLeft
    requestAnimationFrame(() => {
      syncGuard.current = null
    })
  }

  function onMainScroll(e: UIEvent<HTMLDivElement>) {
    if (syncGuard.current === 'top') return
    syncGuard.current = 'main'
    if (topRef.current) topRef.current.scrollLeft = e.currentTarget.scrollLeft
    requestAnimationFrame(() => {
      syncGuard.current = null
    })
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // Let interactive elements receive their native events untouched.
    if (target.closest('a, input, select, textarea')) return
    if (!mainRef.current) return
    dragState.current = {
      startX: e.clientX,
      startScroll: mainRef.current.scrollLeft,
    }
    movedRef.current = false
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // pointer capture can throw if the pointer type isn't captureable
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragState.current || !mainRef.current) return
    const dx = e.clientX - dragState.current.startX
    if (Math.abs(dx) > 3) movedRef.current = true
    mainRef.current.scrollLeft = dragState.current.startScroll - dx
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragState.current) return
    dragState.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  // If the user dragged, kill the click that would otherwise fire
  // (e.g. a click on a SortHeader). If they didn't drag, the click
  // passes through normally.
  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    if (movedRef.current) {
      e.preventDefault()
      e.stopPropagation()
      movedRef.current = false
    }
  }

  return (
    <div className={className}>
      <div
        ref={topRef}
        onScroll={onTopScroll}
        aria-hidden="true"
        className="overflow-x-auto overflow-y-hidden border-b border-[color:var(--color-border)]"
      >
        <div style={{ width: contentWidth, height: 1 }} />
      </div>
      <div
        ref={mainRef}
        onScroll={onMainScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
        className="overflow-x-auto cursor-grab active:cursor-grabbing"
      >
        {children}
      </div>
    </div>
  )
}
