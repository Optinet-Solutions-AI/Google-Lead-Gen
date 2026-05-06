'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { CheckSquare, EyeOff, Square } from 'lucide-react'
import { SortHeader } from '../../monday/_components/sort-header'
import type { LeadRow } from '../_lib/query'
import {
  setAffiliateLabel,
  setContactLabel,
  setRoosterLabel,
  setStagLabel,
  setStagVerifiedLabel,
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
}

export function LeadsTable({ rows, jobContext = false }: Props) {
  const [openLeadId, setOpenLeadId] = useState<number | null>(null)
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

  const visibleIds = useMemo(() => rows.map(r => r.id), [rows])
  const allChecked = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
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
      <div className="hidden overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] md:block">
        <table className="w-full border-collapse text-[11px]">
          <thead className="bg-[color:var(--color-bg-secondary)]">
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
              {jobContext ? (
                <>
                  <Th><SortHeader columnKey="domain" label="Clean domain" sortable /></Th>
                  <Th><SortHeader columnKey="result_type" label="Type" sortable /></Th>
                  <Th><SortHeader columnKey="overall_position" label="Pos" sortable /></Th>
                </>
              ) : (
                <>
                  <Th><SortHeader columnKey="keyword" label="Keyword" sortable /></Th>
                  <Th><SortHeader columnKey="country_code" label="Country" sortable /></Th>
                  <Th><SortHeader columnKey="result_type" label="Type" sortable /></Th>
                  <Th><SortHeader columnKey="overall_position" label="Pos" sortable /></Th>
                  <Th><SortHeader columnKey="domain" label="Domain" sortable /></Th>
                </>
              )}
              <Th>{jobContext ? 'Full URL' : 'URL'}</Th>
              <Th>Is on Monday?</Th>
              <Th>Is an affiliate?</Th>
              <Th>Rooster brand?</Th>
              <Th>S-tags</Th>
              <Th>Verified s-tags</Th>
              <Th>Has contacts?</Th>
              {!jobContext && (
                <Th><SortHeader columnKey="batch_id" label="Batch" sortable /></Th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr
                key={row.id}
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
                {jobContext ? (
                  <>
                    <Td className="max-w-[220px] truncate p-0" title={row.domain ?? ''}>
                      <DomainButton domain={row.domain} onOpen={() => setOpenLeadId(row.id)} />
                    </Td>
                    <Td>
                      <TypeBadge type={row.result_type} />
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
                    <Td>{row.overall_position ?? '—'}</Td>
                    <Td className="p-0">
                      <DomainButton domain={row.domain} onOpen={() => setOpenLeadId(row.id)} />
                    </Td>
                  </>
                )}
                <Td className="max-w-[280px] truncate">
                  {row.url ? (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline underline-offset-2 decoration-[color:var(--color-text-primary)]"
                    >
                      {row.url.length > 55 ? row.url.slice(0, 55) + '…' : row.url}
                    </a>
                  ) : (
                    '—'
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
                <Td>
                  <BooleanLabelEditor
                    leadId={row.id}
                    value={row.s_tags_checked_at !== null ? true : row.has_s_tags === null ? null : false}
                    isOverridden={false}
                    action={setStagVerifiedLabel}
                    yesLabel="Verified"
                    noLabel="Not yet"
                  />
                </Td>
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
        {rows.map(row => (
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
                <button
                  type="button"
                  onClick={() => setOpenLeadId(row.id)}
                  className="truncate text-left text-[13px] font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline"
                >
                  {jobContext ? (row.domain ?? '—') : (row.keyword ?? '—')}
                </button>
              </div>
              <TypeBadge type={row.result_type} />
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
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all font-semibold underline underline-offset-2 decoration-[color:var(--color-text-primary)]"
                  >
                    {row.url.length > 80 ? row.url.slice(0, 80) + '…' : row.url}
                  </a>
                ) : (
                  '—'
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
              <Field label="Verified s-tags">
                <BooleanLabelEditor
                  leadId={row.id}
                  value={row.s_tags_checked_at !== null ? true : row.has_s_tags === null ? null : false}
                  isOverridden={false}
                  action={setStagVerifiedLabel}
                  yesLabel="Verified"
                  noLabel="Not yet"
                />
              </Field>
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
            <p className="mt-1.5 text-[11px] text-[color:var(--color-text-secondary)]">
              {formatTimestamp(row.created_at)}
            </p>
          </div>
        ))}
      </div>

      <LeadDetailDrawer leadId={openLeadId} onClose={() => setOpenLeadId(null)} />
    </>
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
      className="block w-full truncate px-3 py-2 text-left font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline"
    >
      {domain ?? '—'}
    </button>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={[
        'whitespace-nowrap border-b border-[color:var(--color-border)] px-3 py-2 text-left align-middle',
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
