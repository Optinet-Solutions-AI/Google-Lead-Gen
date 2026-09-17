'use client'

import { useActionState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { checkDriftAction, type DriftState } from '../actions'

export type DriftRowView = {
  country_code: string
  country_name: string
  is_active: boolean
  db_profile_id: string | null
  db_display_name: string | null
  live_name: string | null
  state: 'ok' | 'no_id' | 'missing_in_gologin' | 'name_changed' | 'unknown'
}

const STATE_COPY: Record<DriftRowView['state'], { label: string; tone: string; hint: string }> = {
  ok: { label: 'Matches', tone: 'bg-emerald-100 text-emerald-800', hint: 'The stored profile id exists in GoLogin and the name still agrees.' },
  no_id: { label: 'Never linked', tone: 'bg-red-100 text-red-800', hint: 'No GoLogin profile id. Scrapes for this country cannot start a browser.' },
  missing_in_gologin: { label: 'Gone from GoLogin', tone: 'bg-red-100 text-red-800', hint: 'The stored id no longer exists on the GoLogin account. It was deleted or moved.' },
  name_changed: { label: 'Renamed', tone: 'bg-amber-100 text-amber-900', hint: 'The profile still exists but its name changed in GoLogin, so the stored label is stale.' },
  unknown: { label: 'Not checked', tone: 'bg-zinc-100 text-zinc-600', hint: 'GoLogin could not be reached, so this row could not be compared.' },
}

const initial: DriftState = null

/**
 * Country profile to GoLogin comparison. Nothing runs until an admin
 * presses Check, because it calls the GoLogin API.
 */
export function GoLoginDriftPanel({ initialRows }: { initialRows: DriftRowView[] }) {
  const [state, action, pending] = useActionState(checkDriftAction, initial)
  const report = state?.status === 'ok' ? state.report : null
  const rows: DriftRowView[] = report ? report.rows : initialRows
  const problems = rows.filter(r => r.state !== 'ok' && r.state !== 'unknown')

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">Country profiles against GoLogin</h3>
          <p className="mt-0.5 max-w-2xl text-[12px] text-[color:var(--color-text-secondary)]">
            Each country row stores a GoLogin browser profile id. Nothing watches whether that profile was renamed or deleted on the GoLogin side, so this check compares them directly.
          </p>
        </div>
        <form action={action}>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-40"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Check against GoLogin
          </button>
        </form>
      </header>

      {state?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800">{state.error}</p>
      )}
      {report && (
        <p
          className={`flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] ${
            report.ok && problems.length === 0 ? 'bg-emerald-50 text-emerald-800' : report.ok ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800'
          }`}
        >
          {report.ok && problems.length === 0 ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : report.ok ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {report.detail} Checked {new Date(report.checkedAt).toLocaleString()}.
            {report.unmapped.length > 0 && ` ${report.unmapped.length} GoLogin profile${report.unmapped.length === 1 ? '' : 's'} on the account are not linked to any country.`}
          </span>
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12px]">
          <thead>
            <tr className="border-b border-[color:var(--color-border)] text-left text-[10px] uppercase tracking-wider text-[color:var(--color-text-secondary)]">
              <th className="py-1.5 pr-3 font-semibold">Country</th>
              <th className="py-1.5 pr-3 font-semibold">Stored profile id</th>
              <th className="py-1.5 pr-3 font-semibold">Stored name</th>
              <th className="py-1.5 pr-3 font-semibold">Name in GoLogin</th>
              <th className="py-1.5 font-semibold">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const copy = STATE_COPY[r.state]
              return (
                <tr key={r.country_code} className="border-b border-[color:var(--color-border)] last:border-0">
                  <td className="py-1.5 pr-3">
                    <span className="font-medium text-[color:var(--color-text-primary)]">{r.country_name}</span>
                    <span className="text-[color:var(--color-text-secondary)]"> ({r.country_code})</span>
                    {!r.is_active && <span className="ml-1 text-[10px] text-[color:var(--color-text-secondary)]">inactive</span>}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-[color:var(--color-text-secondary)]">
                    {r.db_profile_id ? `${r.db_profile_id.slice(0, 10)}…` : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-[color:var(--color-text-secondary)]">{r.db_display_name ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-[color:var(--color-text-secondary)]">{r.live_name ?? '—'}</td>
                  <td className="py-1.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${copy.tone}`} title={copy.hint}>
                      {copy.label}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {report && report.unmapped.length > 0 && (
        <details className="text-[11px] text-[color:var(--color-text-secondary)]">
          <summary className="cursor-pointer">GoLogin profiles not linked to a country ({report.unmapped.length})</summary>
          <ul className="mt-1 flex flex-wrap gap-1">
            {report.unmapped.map(p => (
              <li key={p.id} className="rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5" title={p.id}>
                {p.name || p.id}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
