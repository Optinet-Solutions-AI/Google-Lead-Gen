'use client'

import { useCallback, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * A dropdown that escapes its container.
 *
 * The leads table scrolls sideways, which makes its wrapper a scroll
 * container — and a scroll container clips absolutely-positioned children.
 * The label menus lived inside a cell, so opening one produced a menu
 * trimmed to the row or hidden behind the table edge entirely: visible
 * enough to know something happened, not enough to click.
 *
 * So the panel renders through a portal on `document.body`, positioned
 * `fixed` against the trigger's rect. Nothing between it and the body can
 * clip it. It flips above the trigger when there isn't room below, and
 * follows the trigger while the page or the table scrolls.
 *
 * Owns its own dismissal — outside click and Escape — because with a
 * portal the panel is no longer a DOM descendant of the trigger, so a
 * "click outside the wrapper" test would fire on the panel's own buttons
 * and close it before they ran.
 */

const MARGIN = 6

export function AnchoredMenu({
  open,
  anchorRef,
  onClose,
  panelRef,
  minWidth = 160,
  children,
  label,
}: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  /** So the caller can keep its arrow-key navigation over the buttons. */
  panelRef: React.RefObject<HTMLDivElement | null>
  minWidth?: number
  children: React.ReactNode
  label?: string
}) {
  // Position is written straight onto the node rather than held in state.
  // It is a DOM fact, not something React renders from, and measuring it
  // requires the node to exist — routing that through setState would mean a
  // second render on every open, scroll and resize.
  const place = useCallback(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!open || !anchor || !panel) return

    const r = anchor.getBoundingClientRect()
    const panelH = panel.offsetHeight
    const panelW = Math.max(panel.offsetWidth, minWidth)

    const below = window.innerHeight - r.bottom
    const flipUp = below < panelH + MARGIN && r.top > below

    // Keep the panel on screen horizontally — a menu opened from the last
    // column would otherwise hang off the right edge.
    const left = Math.min(Math.max(MARGIN, r.left), window.innerWidth - panelW - MARGIN)
    const top = flipUp ? Math.max(MARGIN, r.top - panelH - MARGIN) : r.bottom + MARGIN

    panel.style.top = `${top}px`
    panel.style.left = `${left}px`
    panel.style.visibility = 'visible'
  }, [open, anchorRef, panelRef, minWidth])

  // Measure before paint, so the panel is never seen at the wrong position.
  useLayoutEffect(() => {
    place()
    // Fonts and borders can settle a frame late; re-place so the flip
    // decision is made against the panel's final height.
    const id = requestAnimationFrame(place)
    return () => cancelAnimationFrame(id)
  }, [place])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => place()
    // Capture, so scrolling the table wrapper counts and not just the page.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchorRef, panelRef])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      {...(label ? { 'aria-label': label } : {})}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        minWidth,
        // Above the sticky table header and the sidebar, below a modal.
        zIndex: 55,
        // Revealed by place() once it has been measured.
        visibility: 'hidden',
      }}
      className="max-h-[60vh] overflow-y-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 shadow-lg"
    >
      {children}
    </div>,
    document.body,
  )
}
