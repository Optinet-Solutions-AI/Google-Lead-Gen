/** Central European time formatting (CET / CEST follows the date). */

const CET_ZONE = 'Europe/Berlin'

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: CET_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
})

const fmtDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: CET_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

/** "17 Sept 2026, 23:20 CEST" — or "—" when there is no instant. */
export function formatCet(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return fmt.format(d)
}

export function formatCetDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return fmtDate.format(d)
}
