'use client'

import { useState } from 'react'
import { DashboardModal } from './dashboard-modal'

/**
 * Sortable, click-to-drill leaderboard table. Rows show label + value
 * + optional secondary metric. Row click opens a modal with whatever
 * `drilldown(row)` returns — every dashboard's "top scrapers / top
 * users / top countries" table uses this so operators can click
 * any row for the underlying data.
 */
export type LeaderRow = {
  key: string
  label: string
  value: number
  /** Optional secondary metric shown after the primary (e.g.
   *  success-rate %, delta vs last window). */
  secondary?: string
  /** Optional short badge on the left of the label (e.g. country
   *  flag emoji, engine icon). Rendered inline. */
  badge?: string
}

export function Leaderboard({
  rows,
  valueLabel = 'Count',
  emptyMessage = 'No rows in this window.',
  drilldown,
}: {
  rows: LeaderRow[]
  valueLabel?: string
  emptyMessage?: string
  drilldown?: (row: LeaderRow) => {
    title: string
    subtitle?: string
    body: React.ReactNode
  }
}) {
  const [openRow, setOpenRow] = useState<LeaderRow | null>(null)
  const detail = openRow && drilldown ? drilldown(openRow) : null

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-4 py-6 text-[11px] text-[color:var(--color-text-secondary)]">
        {emptyMessage}
      </div>
    )
  }

  const max = rows.reduce((m, r) => (r.value > m ? r.value : m), 0)

  return (
    <>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-[color:var(--color-border)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            <th className="w-6 py-1.5" />
            <th className="py-1.5">Name</th>
            <th className="py-1.5 text-right">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const barPct = max > 0 ? (row.value / max) * 100 : 0
            const isClickable = !!drilldown
            const cellCls = 'py-1.5'
            const rowContent = (
              <>
                <td className={`${cellCls} text-right text-[10px] text-[color:var(--color-text-secondary)] pr-2`}>
                  {i + 1}
                </td>
                <td className={`${cellCls} min-w-0`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {row.badge && (
                      <span className="text-[11px] font-mono text-[color:var(--color-text-secondary)]">
                        {row.badge}
                      </span>
                    )}
                    <span className="truncate font-medium text-[color:var(--color-text-primary)]">
                      {row.label}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[color:var(--color-bg-secondary)]">
                    <div
                      className="h-full rounded-full bg-[color:var(--color-accent)]/60"
                      style={{ width: `${barPct.toFixed(1)}%` }}
                    />
                  </div>
                </td>
                <td className={`${cellCls} text-right font-mono tabular-nums text-[color:var(--color-text-primary)]`}>
                  {row.value.toLocaleString()}
                  {row.secondary && (
                    <div className="text-[10px] text-[color:var(--color-text-secondary)]">
                      {row.secondary}
                    </div>
                  )}
                </td>
              </>
            )
            return (
              <tr
                key={row.key}
                onClick={isClickable ? () => setOpenRow(row) : undefined}
                className={[
                  'border-b border-[color:var(--color-border)]/60 last:border-b-0',
                  isClickable ? 'cursor-pointer transition-colors hover:bg-[color:var(--color-bg-secondary)]/60' : '',
                ].join(' ')}
                title={isClickable ? 'Click for the rows behind this number' : undefined}
              >
                {rowContent}
              </tr>
            )
          })}
        </tbody>
      </table>
      {detail && openRow && (
        <DashboardModal
          open={!!openRow}
          onClose={() => setOpenRow(null)}
          title={detail.title}
          {...(detail.subtitle ? { subtitle: detail.subtitle } : {})}
        >
          {detail.body}
        </DashboardModal>
      )}
    </>
  )
}
