'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { Check, CheckSquare, ExternalLink, EyeOff, Link2, Send, Square, Zap } from 'lucide-react'
import { SortHeader } from '../../monday/_components/sort-header'
import { RowContextMenu, type ContextMenuAction } from '../../_components/row-context-menu'
import type { LeadRow } from '../_lib/query'
import {
  forceEnrichLeadsAction,
  pushLeadToMondayNotRelevantAction,
  setAffiliateLabel,
  setContactLabel,
  setNotRelevantAction,
  setRoosterLabel,
  setStagLabel,
} from '../actions'
import { BooleanLabelEditor } from './boolean-label-editor'
import { BulkActionsBar } from './bulk-actions-bar'
import { LeadDetailDrawer } from './lead-detail-drawer'
import { MondayLabelEditor } from './monday-label-editor'

type Props = {
  rows: LeadRow[]
  /** When true, hides Keyword/Country/Batch columns and puts Domain first.
   *  Use on /scrape/[id] where those values are shown in the page header. */
  jobContext?: boolean
  /** Pagination metadata for cross-page drawer navigation. Without this,
   *  the drawer's prev/next only walks within the visible page; with it,
   *  the arrows bridge to the next/prev page automatically. */
  pageInfo?: { page: number; size: number; total: number }
}

export function LeadsTable({ rows: initialRows, jobContext = false, pageInfo }: Props) {
  // ----- Infinite scroll (Bundle 3) -----
  // The page server-renders the first chunk (size rows for `page`).
  // After hydration, an IntersectionObserver near the bottom of the
  // table fires a fetch for the NEXT page and appends the rows. The
  // URL stays on the server-rendered page so the pagination chevrons
  // below still work — they just jump straight to that page and
  // reset the appended list.
  const [extraRows, setExtraRows] = useState<LeadRow[]>([])
  const [extraLoading, setExtraLoading] = useState(false)
  const [extraError, setExtraError] = useState<string | null>(null)
  // Tracks the next page to fetch after the SSR'd one. When the
  // server-rendered page changes (filter, sort, size, page click)
  // we reset back to page+1 and clear extras.
  const [nextPage, setNextPage] = useState<number>(
    pageInfo ? pageInfo.page + 1 : 2,
  )
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(
    () => (extraRows.length === 0 ? initialRows : [...initialRows, ...extraRows]),
    [initialRows, extraRows],
  )

  // Drawer is URL-driven via `?lead=<id>` so QA can copy a row link
  // and any teammate clicking it lands on this exact lead's drawer.
  // Local state only as fallback for legacy callers.
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const leadParam = sp.get('lead')
  const openLeadId = leadParam ? Number(leadParam) : null

  const setOpenLeadId = useCallback(
    (id: number | null) => {
      const params = new URLSearchParams(sp.toString())
      if (id === null) params.delete('lead')
      else params.set('lead', String(id))
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname, sp],
  )

  // Cross-page drawer navigation. When the drawer is at the first/last
  // visible lead and the user clicks the back/forward arrow, jump to the
  // adjacent page and open its last/first lead. We can't know that lead's
  // id until the new page renders, so we stash a sentinel `open=first|last`
  // in the URL and resolve it once `rows` updates.
  const totalPages = pageInfo
    ? Math.max(1, Math.ceil(pageInfo.total / pageInfo.size))
    : 1
  const canGoPrevPage = pageInfo !== undefined && pageInfo.page > 1
  const canGoNextPage = pageInfo !== undefined && pageInfo.page < totalPages

  const onBoundary = useCallback(
    (dir: 'prev' | 'next') => {
      if (!pageInfo) return
      const target = dir === 'next' ? pageInfo.page + 1 : pageInfo.page - 1
      if (target < 1 || target > totalPages) return
      const params = new URLSearchParams(sp.toString())
      params.set('page', String(target))
      params.set('open', dir === 'next' ? 'first' : 'last')
      params.delete('lead')
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pageInfo, totalPages, sp, router, pathname],
  )

  // Resolve the `open=first|last` sentinel to a concrete `lead=<id>` once
  // the new page's rows arrive. Uses `replace` so the back button doesn't
  // bounce through this intermediate state.
  useEffect(() => {
    const want = sp.get('open')
    if (!want) return
    const params = new URLSearchParams(sp.toString())
    // No rows on this page — the sentinel can never resolve to a lead here,
    // so strip it rather than leaving ?open=… orphaned in the URL.
    if (rows.length === 0) {
      params.delete('open')
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
      return
    }
    const target = want === 'last' ? rows[rows.length - 1] : rows[0]
    if (!target) return
    params.delete('open')
    params.set('lead', String(target.id))
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [sp, rows, router, pathname])

  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // When the user pages or filters, the row set changes — drop any
  // selected ids that aren't on screen anymore so we don't keep stale
  // selections across navigations.
  const rowIdSig = useMemo(() => rows.map(r => r.id).join(','), [rows])
  useEffect(() => {
    setSelectedIds(prev => {
      const valid = new Set(rows.map(r => r.id))
      const next = new Set<number>()
      for (const id of prev) if (valid.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdSig])

  // Reset the infinite-scroll cursor whenever a NEW server-rendered
  // chunk arrives — filter change, sort change, size change, or a
  // pagination chevron click. We watch the initialRows' id signature
  // (not the merged `rows` sig) so extras growing in-page doesn't
  // trigger a reset and re-fetch loop.
  const initialIdSig = useMemo(
    () => initialRows.map(r => r.id).join(','),
    [initialRows],
  )
  useEffect(() => {
    const resetCursor = () => {
      setExtraRows([])
      setExtraError(null)
      setNextPage(pageInfo ? pageInfo.page + 1 : 2)
    }
    resetCursor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIdSig, pageInfo?.page, pageInfo?.size])

  // Whether there are more rows beyond what we've loaded. true means
  // the sentinel will keep firing loadMore on intersect. false means
  // we've reached the end (or pagination metadata isn't available).
  const accumulatedCount = initialRows.length + extraRows.length
  const hasMore =
    pageInfo !== undefined &&
    pageInfo.size > 0 &&
    accumulatedCount < pageInfo.total &&
    accumulatedCount > 0

  const loadMore = useCallback(async () => {
    if (!pageInfo || pageInfo.size === 0) return
    if (extraLoading) return
    if (!hasMore) return
    setExtraLoading(true)
    setExtraError(null)
    try {
      const params = new URLSearchParams(sp.toString())
      // Replace pagination knobs with our cursor while leaving filter
      // params (q, f, s, country_code, result_type, show_hidden, sort,
      // order) intact.
      params.set('page', String(nextPage))
      params.set('size', String(pageInfo.size))
      // The `lead` (drawer) + `open` (cross-page sentinel) keys aren't
      // meaningful for a data fetch — strip them so they don't pollute
      // the API URL.
      params.delete('lead')
      params.delete('open')
      const res = await fetch(`/api/leads?${params.toString()}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as { rows: LeadRow[]; total: number }
      if (!Array.isArray(data.rows)) {
        throw new Error('Bad payload: rows is not an array.')
      }
      setExtraRows(prev => prev.concat(data.rows))
      setNextPage(p => p + 1)
    } catch (err) {
      setExtraError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtraLoading(false)
    }
  }, [extraLoading, hasMore, nextPage, pageInfo, sp])

  // Watch the sentinel div with IntersectionObserver. Threshold 0
  // (any pixel of overlap) + a 200px rootMargin so the next fetch
  // starts BEFORE the user actually reaches the bottom — smoother
  // scrolling, no visible "loading more" jump.
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    if (!hasMore) return
    const obs = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMore()
            break
          }
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 },
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [hasMore, loadMore])

  // Absolute rank for the row-number column. Uses pageInfo so the second
  // page picks up where the first left off (size 50 → page 2 starts at 51).
  // Falls back to local index when pageInfo isn't provided.
  const rowNumberOffset = pageInfo ? (pageInfo.page - 1) * pageInfo.size : 0

  const visibleIds = useMemo(() => rows.map(r => r.id), [rows])
  const allChecked = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))

  // ----- Ctrl+Click selection + right-click context menu -----
  // Right-clicking a row pops a small menu with row + bulk actions.
  // Ctrl/Cmd+Click toggles the row in/out of the selection without
  // entering full select-mode — quick "grab a few rows" UX without
  // turning on the checkbox column.
  const [contextCursor, setContextCursor] = useState<{ x: number; y: number } | null>(null)
  const [contextRowId, setContextRowId] = useState<number | null>(null)
  const [actionPending, startAction] = useTransition()
  const [contextToast, setContextToast] = useState<{ ok: boolean; text: string } | null>(null)

  // Auto-dismiss the success/error toast after a few seconds so it
  // doesn't linger across navigations.
  useEffect(() => {
    if (!contextToast) return
    const t = setTimeout(() => setContextToast(null), contextToast.ok ? 4000 : 8000)
    return () => clearTimeout(t)
  }, [contextToast])

  function onRowClickCapture(e: React.MouseEvent, leadId: number) {
    const isCtrl = e.ctrlKey || e.metaKey
    const isSelected = selectedIds.has(leadId)
    const hasSelection = selectedIds.size > 0

    // Ctrl/Cmd+Click → toggle this row in the selection. Capture
    // phase intercepts BEFORE descendant link cells fire so the URL
    // cell can't open a new tab.
    if (isCtrl) {
      e.preventDefault()
      e.stopPropagation()
      if (!selectMode) setSelectMode(true)
      setSelectedIds(prev => {
        const next = new Set(prev)
        if (next.has(leadId)) next.delete(leadId)
        else next.add(leadId)
        return next
      })
      return
    }

    // Plain click on a row WHILE a selection exists → pop the
    // actions menu at the cursor. The menu scopes its actions to
    // the active selection ("Force enrich 5 leads", "Push 5 to Not
    // Relevant"). Operator dismisses with Escape or by clicking
    // outside; ctrl+click is still the way to add/remove from the
    // selection.
    if (hasSelection) {
      e.preventDefault()
      e.stopPropagation()
      // If the operator clicked an unselected row, scope the menu
      // to the existing selection — don't silently add the clicked
      // row. They can ctrl-click to extend before clicking again.
      // If they clicked a selected row, also fine — same scope.
      void isSelected
      setContextRowId(leadId)
      setContextCursor({ x: e.clientX, y: e.clientY })
      return
    }

    // No selection + no ctrl → fall through. DomainButton opens
    // the drawer, URL link opens a new tab.
  }

  function onRowMouseDownCapture(e: React.MouseEvent) {
    if (e.button !== 0) return
    const isCtrl = e.ctrlKey || e.metaKey
    const hasSelection = selectedIds.size > 0
    // Belt-and-suspenders preventDefault for ctrl+click AND for
    // plain click while a selection is active. Same two paths the
    // click handler intercepts, just one event earlier — kills the
    // focus / text-selection side effects of those modified clicks.
    if (!isCtrl && !hasSelection) return
    e.preventDefault()
  }

  function onRowContextMenu(e: React.MouseEvent, leadId: number) {
    e.preventDefault()
    // If the right-clicked row isn't already selected, treat the
    // context menu as scoped to just that row (don't disturb an
    // existing selection — the menu's "N selected" hint makes it
    // clear which scope an action will apply to).
    if (!selectedIds.has(leadId) && selectedIds.size === 0) {
      setSelectedIds(new Set([leadId]))
      if (!selectMode) setSelectMode(true)
    }
    setContextRowId(leadId)
    setContextCursor({ x: e.clientX, y: e.clientY })
  }

  function buildContextActions(): ContextMenuAction[] {
    const rowId = contextRowId
    if (rowId === null) return []
    const targetIds = selectedIds.size > 0 ? Array.from(selectedIds) : [rowId]
    const n = targetIds.length
    const isBulk = n > 1
    return [
      {
        label: 'Open lead',
        icon: ExternalLink,
        disabled: isBulk,
        hint: isBulk ? 'Disabled — drawer only opens one lead at a time' : undefined,
        onClick: () => setOpenLeadId(rowId),
        separatorAfter: true,
      },
      {
        label: isBulk ? `Force enrich ${n} leads` : 'Force enrich',
        icon: Zap,
        hint: 'Re-run enrichment even if already on Monday / not relevant',
        onClick: () =>
          startAction(async () => {
            const result = await forceEnrichLeadsAction(targetIds)
            setContextToast(
              result.ok
                ? { ok: true, text: `Queued ${result.queued} lead${result.queued === 1 ? '' : 's'} for re-enrichment.` }
                : { ok: false, text: result.error },
            )
          }),
      },
      {
        label: isBulk ? `Mark ${n} as not relevant` : 'Mark as not relevant',
        icon: EyeOff,
        hint: 'Local flag only — hides from /leads + skips enrichment. Does NOT push to Monday.',
        onClick: () =>
          startAction(async () => {
            let updated = 0
            const errors: string[] = []
            for (const id of targetIds) {
              const fd = new FormData()
              fd.set('lead_id', String(id))
              fd.set('value', 'true')
              const result = await setNotRelevantAction(null, fd)
              if (result?.status === 'ok') updated += 1
              else if (result?.status === 'error') errors.push(`#${id}: ${result.error}`)
            }
            setContextToast(
              errors.length === 0
                ? { ok: true, text: `Marked ${updated} lead${updated === 1 ? '' : 's'} as not relevant.` }
                : { ok: false, text: `Marked ${updated}/${targetIds.length}. Errors: ${errors.slice(0, 2).join('; ')}` },
            )
            if (errors.length === 0) setSelectedIds(new Set())
          }),
        separatorAfter: true,
      },
      {
        label: isBulk ? `Push ${n} to Not Relevant` : 'Push to Monday Not Relevant',
        icon: Send,
        // Bulk push is heavy — N sequential create_item calls. Keep
        // bulk allowed but warn via the hint so operators know what
        // they're triggering.
        hint: isBulk
          ? `Creates ${n} items on Monday — runs sequentially, may take a minute`
          : 'Creates a Not Relevant board item and marks this lead not-relevant',
        onClick: () =>
          startAction(async () => {
            let pushed = 0
            const errors: string[] = []
            for (const id of targetIds) {
              const fd = new FormData()
              fd.set('lead_id', String(id))
              const result = await pushLeadToMondayNotRelevantAction(null, fd)
              if (result?.status === 'ok') pushed += 1
              else if (result?.status === 'error') errors.push(`#${id}: ${result.error}`)
            }
            setContextToast(
              errors.length === 0
                ? { ok: true, text: `Pushed ${pushed} lead${pushed === 1 ? '' : 's'} to Monday Not Relevant.` }
                : {
                    ok: false,
                    text: `Pushed ${pushed}/${targetIds.length}. Errors: ${errors.slice(0, 2).join('; ')}`,
                  },
            )
            // Clear selection after a successful bulk push so the
            // next right-click starts fresh.
            if (errors.length === 0) setSelectedIds(new Set())
          }),
      },
    ]
  }

  const toggleAll = () => {
    setSelectedIds(prev => {
      if (allChecked) {
        const next = new Set(prev)
        for (const id of visibleIds) next.delete(id)
        return next
      }
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })
  }
  const toggleOne = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-10 text-center text-[12px] text-[color:var(--color-text-secondary)]">
        No results match the current filters.
      </div>
    )
  }

  return (
    <>
      {/* Toolbar — select-mode toggle. Hidden by default; flipping it on
       *  reveals a checkbox column + the bulk-action bar above the table. */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => {
            setSelectMode(s => !s)
            if (selectMode) setSelectedIds(new Set())
          }}
          className={[
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
            selectMode
              ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
              : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
          ].join(' ')}
          title={selectMode ? 'Hide selection checkboxes' : 'Show selection checkboxes for bulk actions'}
        >
          {selectMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
          {selectMode ? 'Selecting' : 'Select rows'}
        </button>
      </div>

      {/* Bulk-action bar — sits above the table when 1+ rows are selected. */}
      {selectMode && selectedIds.size > 0 && (
        <BulkActionsBar
          selectedIds={Array.from(selectedIds)}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* Desktop — table */}
      {/* No inner overflow: per CSS spec, overflow-x:auto + overflow-y:visible
       *  still promotes the y-axis to a scroll container, which traps the
       *  sticky <th> inside the wrapper. On tall tables (e.g. /scrape/[id]?size=100)
       *  scrolling the page then lifts the whole wrapper — and the "sticky"
       *  header — above the viewport. Letting the page own both axes keeps
       *  per-cell sticky pinned to the viewport top. Wide tables fall back to
       *  page-level horizontal scroll, which is acceptable for this layout. */}
      <div className="hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] md:block">
        <table className="w-full border-collapse text-[11px]">
          {/* Sticky lives on each <th> below (not on <thead>). HTML
           *  table layout doesn't reliably honour position:sticky on
           *  the row-group element across browsers; per-cell sticky
           *  works everywhere. */}
          <thead className="bg-[color:var(--color-border-strong)]">
            <tr>
              {selectMode && (
                <Th className="w-8 px-2">
                  <input
                    type="checkbox"
                    aria-label={allChecked ? 'Deselect all visible' : 'Select all visible'}
                    checked={allChecked}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--color-accent)]"
                  />
                </Th>
              )}
              <Th className="w-10 text-right tabular-nums text-[color:var(--color-text-secondary)]">#</Th>
              {jobContext ? (
                <>
                  <Th><SortHeader columnKey="domain" label="Clean domain" sortable /></Th>
                  <Th><SortHeader columnKey="result_type" label="Type" sortable /></Th>
                  <Th><SortHeader columnKey="seen_on" label="View" sortable /></Th>
                  <Th><SortHeader columnKey="overall_position" label="Pos" sortable /></Th>
                </>
              ) : (
                <>
                  <Th><SortHeader columnKey="keyword" label="Keyword" sortable /></Th>
                  <Th><SortHeader columnKey="country_code" label="Country" sortable /></Th>
                  <Th><SortHeader columnKey="result_type" label="Type" sortable /></Th>
                  <Th><SortHeader columnKey="seen_on" label="View" sortable /></Th>
                  <Th><SortHeader columnKey="overall_position" label="Pos" sortable /></Th>
                  <Th><SortHeader columnKey="domain" label="Domain" sortable /></Th>
                </>
              )}
              <Th>{jobContext ? 'Full URL' : 'URL'}</Th>
              <Th>Is on Monday?</Th>
              <Th>Is an affiliate?</Th>
              <Th>Rooster brand?</Th>
              <Th>S-tags</Th>
              {/* "Verified s-tags" column hidden — backend stage still
                runs on the lead row (s_tags_checked_at), surface again
                later when the workflow is finalised. */}
              <Th>Has contacts?</Th>
              {!jobContext && (
                <Th><SortHeader columnKey="batch_id" label="Batch" sortable /></Th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.id}
                onMouseDownCapture={onRowMouseDownCapture}
                onClickCapture={e => onRowClickCapture(e, row.id)}
                onContextMenu={e => onRowContextMenu(e, row.id)}
                className={[
                  'border-b border-[color:var(--color-border)] transition-colors last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]',
                  selectMode && selectedIds.has(row.id)
                    ? 'bg-[color:var(--color-accent)]/10'
                    : '',
                ].join(' ')}
              >
                {selectMode && (
                  <Td className="w-8 px-2">
                    <input
                      type="checkbox"
                      aria-label={`Select lead ${row.id}`}
                      checked={selectedIds.has(row.id)}
                      onChange={() => toggleOne(row.id)}
                      className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--color-accent)]"
                    />
                  </Td>
                )}
                <Td className="w-10 text-right tabular-nums text-[color:var(--color-text-secondary)]">
                  {rowNumberOffset + index + 1}
                </Td>
                {jobContext ? (
                  <>
                    <Td className="max-w-[220px] truncate p-0" title={row.domain ?? ''}>
                      <DomainButton domain={row.domain} onOpen={() => setOpenLeadId(row.id)} />
                    </Td>
                    <Td>
                      <TypeBadge type={row.result_type} />
                    </Td>
                    <Td>
                      <SeenOnBadge seenOn={row.seen_on} />
                    </Td>
                    <Td>{row.overall_position ?? '—'}</Td>
                  </>
                ) : (
                  <>
                    <Td className="max-w-[220px] truncate" title={row.keyword ?? ''}>
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{row.keyword ?? '—'}</span>
                        {row.is_not_relevant && <NotRelevantPill />}
                      </div>
                      {(row.created_by_display || row.created_by_username) && (
                        <div
                          className="truncate text-[10px] font-normal text-[color:var(--color-text-secondary)]"
                          title={`Queued by ${row.created_by_display || row.created_by_username}`}
                        >
                          by {row.created_by_display || row.created_by_username}
                        </div>
                      )}
                    </Td>
                    <Td>{row.country_code ?? '—'}</Td>
                    <Td>
                      <TypeBadge type={row.result_type} />
                    </Td>
                    <Td>
                      <SeenOnBadge seenOn={row.seen_on} />
                    </Td>
                    <Td>{row.overall_position ?? '—'}</Td>
                    <Td className="p-0">
                      <DomainButton domain={row.domain} onOpen={() => setOpenLeadId(row.id)} />
                    </Td>
                  </>
                )}
                <Td className="max-w-[280px]">
                  {row.url ? (
                    <div className="flex items-center gap-1.5">
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate font-semibold underline underline-offset-2 decoration-[color:var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] rounded-sm"
                        title={row.url}
                      >
                        {row.url.length > 55 ? row.url.slice(0, 55) + '…' : row.url}
                      </a>
                      <CopyRowLinkButton leadId={row.id} />
                    </div>
                  ) : (
                    <CopyRowLinkButton leadId={row.id} />
                  )}
                </Td>
                <Td>
                  <MondayLabelEditor
                    leadId={row.id}
                    isOnMonday={row.is_on_monday}
                    board={row.monday_board}
                    isOverridden={row.monday_overridden_at !== null}
                  />
                </Td>
                <Td>
                  <BooleanLabelEditor
                    leadId={row.id}
                    value={row.is_affiliate}
                    isOverridden={row.is_affiliate_overridden_at !== null}
                    action={setAffiliateLabel}
                  />
                </Td>
                <Td>
                  <BooleanLabelEditor
                    leadId={row.id}
                    value={row.is_rooster_partner}
                    isOverridden={row.is_rooster_overridden_at !== null}
                    action={setRoosterLabel}
                  />
                </Td>
                <Td>
                  <BooleanLabelEditor
                    leadId={row.id}
                    value={row.has_s_tags}
                    isOverridden={row.is_stag_overridden_at !== null}
                    action={setStagLabel}
                  />
                </Td>
                {/* Verified-s-tags cell removed — see Th comment above. */}
                <Td>
                  <BooleanLabelEditor
                    leadId={row.id}
                    value={row.has_contact_details}
                    isOverridden={row.is_contact_overridden_at !== null}
                    action={setContactLabel}
                  />
                </Td>
                {!jobContext && (
                  <Td>
                    {row.scrape_job_id ? (
                      <Link
                        href={`/scrape/${row.scrape_job_id}`}
                        className="underline underline-offset-2 decoration-[color:var(--color-text-secondary)] hover:decoration-[color:var(--color-text-primary)]"
                      >
                        {row.batch_id ?? '—'}
                      </Link>
                    ) : (
                      row.batch_id ?? '—'
                    )}
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile — card list */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row, index) => (
          <div
            key={row.id}
            className={[
              'rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3',
              selectMode && selectedIds.has(row.id)
                ? 'ring-2 ring-[color:var(--color-accent)]'
                : '',
            ].join(' ')}
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {selectMode && (
                  <input
                    type="checkbox"
                    aria-label={`Select lead ${row.id}`}
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleOne(row.id)}
                    className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[color:var(--color-accent)]"
                  />
                )}
                <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--color-text-secondary)]">
                  {rowNumberOffset + index + 1}.
                </span>
                <button
                  type="button"
                  onClick={() => setOpenLeadId(row.id)}
                  className="truncate text-left text-[13px] font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline"
                >
                  {jobContext ? (row.domain ?? '—') : (row.keyword ?? '—')}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <TypeBadge type={row.result_type} />
                <SeenOnBadge seenOn={row.seen_on} />
              </div>
            </div>
            <dl className="space-y-1 text-[12px]">
              {!jobContext && <Field label="Country">{row.country_code ?? '—'}</Field>}
              {!jobContext && <Field label="Domain">{row.domain ?? '—'}</Field>}
              {!jobContext && (row.created_by_display || row.created_by_username) && (
                <Field label="Queued by">
                  {row.created_by_display || row.created_by_username}
                </Field>
              )}
              <Field label="URL">
                {row.url ? (
                  <span className="inline-flex items-start gap-1.5">
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all font-semibold underline underline-offset-2 decoration-[color:var(--color-text-primary)]"
                    >
                      {row.url.length > 80 ? row.url.slice(0, 80) + '…' : row.url}
                    </a>
                    <CopyRowLinkButton leadId={row.id} />
                  </span>
                ) : (
                  <CopyRowLinkButton leadId={row.id} />
                )}
              </Field>
              <Field label="Is on Monday?">
                <MondayLabelEditor
                  leadId={row.id}
                  isOnMonday={row.is_on_monday}
                  board={row.monday_board}
                  isOverridden={row.monday_overridden_at !== null}
                />
              </Field>
              <Field label="Is an affiliate?">
                <BooleanLabelEditor
                  leadId={row.id}
                  value={row.is_affiliate}
                  isOverridden={row.is_affiliate_overridden_at !== null}
                  action={setAffiliateLabel}
                />
              </Field>
              <Field label="Rooster brand?">
                <BooleanLabelEditor
                  leadId={row.id}
                  value={row.is_rooster_partner}
                  isOverridden={row.is_rooster_overridden_at !== null}
                  action={setRoosterLabel}
                />
              </Field>
              <Field label="S-tags">
                <BooleanLabelEditor
                  leadId={row.id}
                  value={row.has_s_tags}
                  isOverridden={row.is_stag_overridden_at !== null}
                  action={setStagLabel}
                />
              </Field>
              {/* Verified s-tags Field hidden — see desktop Th comment. */}
              <Field label="Has contacts?">
                <BooleanLabelEditor
                  leadId={row.id}
                  value={row.has_contact_details}
                  isOverridden={row.is_contact_overridden_at !== null}
                  action={setContactLabel}
                />
              </Field>
              {!jobContext && (
                <Field label="Batch">
                  {row.scrape_job_id ? (
                    <Link
                      href={`/scrape/${row.scrape_job_id}`}
                      className="underline underline-offset-2"
                    >
                      {row.batch_id ?? '—'}
                    </Link>
                  ) : (
                    row.batch_id ?? '—'
                  )}
                </Field>
              )}
            </dl>
            <p className="mt-1.5 text-[11px] text-[color:var(--color-text-secondary)]" suppressHydrationWarning>
              {formatTimestamp(row.created_at)}
            </p>
          </div>
        ))}
      </div>

      {/* Infinite-scroll sentinel + status row. The sentinel is a
       *  small invisible div the IntersectionObserver watches. The
       *  status row sits below the visible rows and shows the
       *  Loading/Error/Loaded-all states so the operator never
       *  wonders why the list stopped growing. */}
      {pageInfo && pageInfo.size > 0 && (
        <>
          <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
          <div className="flex items-center justify-center py-3 text-[11px] text-[color:var(--color-text-secondary)]">
            {extraLoading ? (
              <span>Loading more…</span>
            ) : extraError ? (
              <span className="rounded-md bg-red-50 px-2 py-1 text-red-800">
                Failed to load more: {extraError}{' '}
                <button
                  type="button"
                  onClick={loadMore}
                  className="ml-2 underline underline-offset-2"
                >
                  Retry
                </button>
              </span>
            ) : hasMore ? (
              <span>Scroll to load more · {accumulatedCount.toLocaleString()} of {pageInfo.total.toLocaleString()}</span>
            ) : accumulatedCount > 0 ? (
              <span>All {accumulatedCount.toLocaleString()} {accumulatedCount === 1 ? 'row' : 'rows'} loaded.</span>
            ) : null}
          </div>
        </>
      )}

      <LeadDetailDrawer
        leadId={openLeadId}
        leadIds={visibleIds}
        onClose={() => setOpenLeadId(null)}
        onNavigate={setOpenLeadId}
        onBoundary={onBoundary}
        canGoPrevPage={canGoPrevPage}
        canGoNextPage={canGoNextPage}
      />

      <RowContextMenu
        cursor={contextCursor}
        actions={buildContextActions()}
        onClose={() => {
          setContextCursor(null)
          setContextRowId(null)
        }}
      />

      {(actionPending || contextToast) && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50">
          <div
            className={[
              'rounded-md px-3 py-2 text-[12px] shadow-lg',
              actionPending
                ? 'bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] border border-[color:var(--color-border)]'
                : contextToast?.ok
                  ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                  : 'bg-red-100 text-red-800 border border-red-300',
            ].join(' ')}
          >
            {actionPending ? 'Working…' : contextToast?.text}
          </div>
        </div>
      )}
    </>
  )
}

/** Copies a permalink that opens THIS row's drawer when clicked.
 *  Used during QA so testers can paste a link in the feedback widget
 *  (or chat) and the admin lands on the same row + drawer with one
 *  click — no need to re-search through filters/pages.
 *
 *  The drawer is URL-driven via `?lead=<id>` (see LeadsTable above),
 *  so the link is just the current path with that param set + the
 *  page-1 reset so the row is guaranteed visible regardless of where
 *  the link recipient was last paginated to. */
function CopyRowLinkButton({ leadId }: { leadId: number }) {
  const pathname = usePathname()
  const sp = useSearchParams()
  const [copied, setCopied] = useState(false)

  const handle = async () => {
    const params = new URLSearchParams(sp.toString())
    params.set('lead', String(leadId))
    // Reset page=1 so the recipient sees the row regardless of where
    // the sender was paginated to. Filters / sorts are preserved.
    params.delete('page')
    const qs = params.toString()
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const link = `${origin}${pathname}${qs ? `?${qs}` : ''}`

    try {
      await navigator.clipboard.writeText(link)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = link
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* give up silently */
      }
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={handle}
      title={copied ? 'Copied row link!' : 'Copy link to this row (opens the drawer when shared)'}
      aria-label={copied ? 'Copied row link' : 'Copy row link'}
      className={[
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
        copied
          ? 'bg-emerald-100 text-emerald-700'
          : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
      ].join(' ')}
    >
      {copied ? <Check className="h-3 w-3" strokeWidth={3} /> : <Link2 className="h-3 w-3" />}
    </button>
  )
}

function NotRelevantPill() {
  return (
    <span
      title="Marked not relevant — hidden from default /leads view, skipped by enrichment."
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
    >
      <EyeOff className="h-2.5 w-2.5" />
      hidden
    </span>
  )
}

function DomainButton({
  domain,
  onOpen,
}: {
  domain: string | null
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full truncate px-3 py-2 text-left font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--color-accent)]"
    >
      {domain ?? '—'}
    </button>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      // Per-cell sticky pins to the viewport top as the page scrolls.
      // Background colour is mandatory — without it the cell would be
      // transparent in the stuck state and body rows would bleed
      // through underneath.
      className={[
        'sticky top-0 z-20 whitespace-nowrap border-b border-[color:var(--color-border-strong)] bg-[color:var(--color-border-strong)] px-3 py-2 text-left align-middle font-semibold text-[color:var(--color-text-primary)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <td
      {...(title ? { title } : {})}
      className={['whitespace-nowrap px-3 py-2 align-top text-[color:var(--color-text-primary)]', className ?? ''].join(' ')}
    >
      {children}
    </td>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-[color:var(--color-text-secondary)]">{label}:</dt>
      <dd className="min-w-0 text-[color:var(--color-text-primary)]">{children}</dd>
    </div>
  )
}

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return <span className="text-[color:var(--color-text-secondary)]">—</span>
  const styles =
    type === 'PPC'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]'
  return (
    <span className={['inline-block rounded-full px-2 py-0.5 text-[10px] font-medium', styles].join(' ')}>
      {type}
    </span>
  )
}

function SeenOnBadge({ seenOn }: { seenOn?: string | null | undefined }) {
  // Show one of three badges so operators can audit which view captured
  // each lead. Rows from before the mobile-pass feature landed have
  // seen_on=null — render a muted "?" so they're visible as legacy.
  if (seenOn === 'mobile') {
    return (
      <span
        className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-800"
        title="Mobile-only: this URL only appeared when the SERP was loaded with an iPhone UA + 375x812 viewport."
      >
        mobile
      </span>
    )
  }
  if (seenOn === 'both') {
    return (
      <span
        className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[9px] font-medium text-sky-800"
        title="Cross-device: same URL was seen in BOTH the desktop and mobile SERP passes."
      >
        both
      </span>
    )
  }
  if (seenOn === 'desktop') {
    return (
      <span
        className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-700"
        title="Desktop-only: this URL was seen only in the desktop SERP pass (mobile pass either didn't run, didn't return it, or aborted)."
      >
        desktop
      </span>
    )
  }
  // null / unknown — pre-feature row or skipped pass
  return (
    <span
      className="rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[9px] font-medium text-[color:var(--color-text-secondary)]"
      aria-label="View not recorded"
      title="seen_on not recorded — row likely predates the mobile-pass feature."
    >
      —
    </span>
  )
}

function formatTimestamp(iso: string): string {
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
