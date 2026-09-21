'use client'

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Centred modal for a decision the person has to answer before anything
 * happens.
 *
 * Exists because the duplicate-scrape warning used to render inline at the
 * bottom of the page: on a long form you pressed Submit, the answer appeared
 * below the fold, and it read as "nothing happened".
 *
 * Sits above the QA feedback launcher (z-50), restores body scroll on close,
 * closes on Escape and on a backdrop click — safe here because the action was
 * rejected, so dismissing changes nothing.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  /** Width cap; the modal is always at least a comfortable phone width. */
  width = '42rem',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  width?: string
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    // Stop the page behind from scrolling under the modal.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center overflow-y-auto bg-black/40 p-0 sm:items-center sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ maxWidth: width }}
        className="my-auto flex max-h-[92vh] min-h-0 w-full flex-col overflow-hidden rounded-t-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-primary)] shadow-2xl outline-none sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[color:var(--color-text-primary)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>
  )
}
