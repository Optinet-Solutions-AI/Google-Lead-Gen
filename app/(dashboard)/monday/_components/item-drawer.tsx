'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'
import { useCallback, useEffect } from 'react'

type Update = Record<string, unknown>
type Item = Record<string, unknown>

type Props = {
  /** The currently-selected monday_item_id (URL-driven). Empty string means closed. */
  itemId: string
  item: Item | null
  updates: Update[]
  boardLabel: string
}

export function ItemDrawer({ itemId, item, updates, boardLabel }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  const open = itemId.length > 0

  // useCallback so the function reference is stable when sp/pathname/
  // router don't change. The Esc effect deps include `close`, so it
  // re-attaches only when those URL inputs actually change — this is
  // what fixes the stale-searchParams bug (BUGS.md R2-30): filtering
  // the table while the drawer is open used to leave the Esc handler
  // closed over the OLD sp, silently dropping filter changes on close.
  const close = useCallback(() => {
    const params = new URLSearchParams(sp.toString())
    params.delete('item')
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [sp, pathname, router])

  // Esc to close
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [open])

  const heading = stringish(item?.name) ?? (itemId ? `Item ${itemId}` : 'Item')

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={close}
        className={[
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Updates for ${heading}`}
        className={[
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col',
          'border-l border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]',
          'shadow-xl transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[11px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              {boardLabel}
            </p>
            <h2 className="mt-0.5 truncate text-[14px] font-semibold text-[color:var(--color-text-primary)]">
              {heading}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="rounded-md p-1 text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {item && (
            <ItemSummary item={item} />
          )}

          <div className="mt-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              {updates.length} Update{updates.length === 1 ? '' : 's'}
            </h3>
            {updates.length === 0 ? (
              <p className="mt-2 rounded-md border border-dashed border-[color:var(--color-border)] px-3 py-6 text-center text-[12px] text-[color:var(--color-text-secondary)]">
                No updates on this item yet.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-3">
                {updates.map(u => (
                  <UpdateCard key={String(u.monday_update_id ?? u.id)} update={u} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ItemSummary({ item }: { item: Item }) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: 'Email', value: stringish(item.email) },
    { label: 'Website', value: stringish(item.website) },
    { label: 'Status', value: stringish(item.status) },
    { label: 'Owner', value: stringish(item.owner) },
    { label: 'Keywords', value: stringish(item.keywords) },
    { label: 'Date', value: stringish(item.date) },
  ].filter(f => f.value)

  if (fields.length === 0) return null

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-[color:var(--color-bg-secondary)] px-3 py-2 text-[12px]">
      {fields.map(f => (
        <div key={f.label} className="contents">
          <dt className="text-[color:var(--color-text-secondary)]">{f.label}</dt>
          <dd className="min-w-0 break-words text-[color:var(--color-text-primary)]">
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function UpdateCard({ update }: { update: Update }) {
  const creator = stringish(update.creator_name) ?? 'Unknown'
  const createdAt = stringish(update.monday_created_at)
  const bodyText = stringish(update.body_text) ?? stringish(update.body_html) ?? ''

  return (
    <li className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-medium text-[color:var(--color-text-primary)]">
          {creator}
        </p>
        {createdAt && (
          <p className="shrink-0 text-[11px] text-[color:var(--color-text-secondary)]">
            {formatWhen(createdAt)}
          </p>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-[color:var(--color-text-primary)]">
        {bodyText}
      </p>
    </li>
  )
}

function stringish(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.trim().length === 0 ? null : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
