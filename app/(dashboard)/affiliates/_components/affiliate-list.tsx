'use client'

import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Link2,
  Mail,
  ShieldCheck,
  Tag,
} from 'lucide-react'
import {
  RECENCY_DOT,
  RECENCY_LABEL,
  daysSince,
  formatDaysAgo,
  recencyBand,
  type RecencyBands,
} from '@/lib/website-profiles/recency'
import type { AffiliateRow, CtaLink } from '../_lib/query'

/** Cards cover phones and tablets; the table starts at `lg`. Matches the
 *  scraping page so the two lists behave the same way on a phone. */
const PAGE = 10

type Props = {
  rows: AffiliateRow[]
  total: number
  bands: RecencyBands
  nowMs: number
}

export function AffiliateList({ rows, total, bands, nowMs }: Props) {
  const [visible, setVisible] = useState(PAGE)
  const shown = rows.slice(0, visible)
  const hasMore = visible < rows.length

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)]/40 px-4 py-10 text-center">
        <p className="text-[13px] font-medium text-[color:var(--color-text-primary)]">Nothing here yet</p>
        <p className="max-w-md text-[12px] text-[color:var(--color-text-secondary)]">
          The AI analysis runs every two hours over websites that are not already on Monday and not marked
          not-relevant. If it is switched off, turn it on under System Settings.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ---------- phones + tablets ---------- */}
      <div className="flex flex-col gap-2 lg:hidden">
        {shown.map(r => (
          <AffiliateCard key={r.id} row={r} bands={bands} nowMs={nowMs} />
        ))}
      </div>

      {/* ---------- desktop ---------- */}
      <div className="hidden overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] lg:block">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <Th className="w-8" />
              <Th>Website</Th>
              <Th className="w-16">Country</Th>
              <Th className="w-20 text-right">Brands</Th>
              <Th className="w-24 text-right">CTA links</Th>
              <Th className="w-28">Our brands</Th>
              <Th className="w-24">Contact</Th>
              <Th className="w-32">S-tag pass</Th>
              <Th className="w-28">Last seen</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <AffiliateTableRow key={r.id} row={r} bands={bands} nowMs={nowMs} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col items-center gap-2 py-1">
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()}
          {total > rows.length && ` (${total.toLocaleString()} match the filter)`}
        </p>
        {hasMore && (
          <button
            type="button"
            onClick={() => setVisible(v => v + PAGE)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-2 text-[12.5px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            Load {PAGE} more
          </button>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ row ----

function AffiliateTableRow({ row, bands, nowMs }: { row: AffiliateRow; bands: RecencyBands; nowMs: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr className="border-t border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-secondary)]">
        <Td>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-label={open ? 'Hide CTA links' : 'Show CTA links'}
            className="rounded p-0.5 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </Td>
        <Td className="max-w-[320px]">
          <div className="flex min-w-0 items-center gap-1.5">
            <a
              href={`https://${row.normalized_domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline"
            >
              {row.normalized_domain}
            </a>
            <ExternalLink className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />
          </div>
        </Td>
        <Td className="text-[color:var(--color-text-secondary)]">{row.country_code ?? '—'}</Td>
        <Td className="text-right tabular-nums">{row.ai_brand_count ?? 0}</Td>
        <Td className="text-right">
          <CtaCount row={row} />
        </Td>
        <Td><RoosterCell row={row} /></Td>
        <Td><ContactCell row={row} /></Td>
        <Td><StagCell row={row} /></Td>
        <Td><LastSeen iso={row.last_seen_at} bands={bands} nowMs={nowMs} /></Td>
      </tr>
      {open && (
        <tr className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/40">
          <td colSpan={9} className="px-4 py-3">
            <CtaPanel profileId={row.id} domain={row.normalized_domain} />
          </td>
        </tr>
      )}
    </>
  )
}

function AffiliateCard({ row, bands, nowMs }: { row: AffiliateRow; bands: RecencyBands; nowMs: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            href={`https://${row.normalized_domain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-[13px] font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline"
          >
            {row.normalized_domain}
          </a>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--color-text-secondary)]">
            <span>{row.country_code ?? '—'}</span>
            <span>{row.ai_brand_count ?? 0} brands</span>
            <LastSeen iso={row.last_seen_at} bands={bands} nowMs={nowMs} />
          </div>
        </div>
        <CtaCount row={row} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <RoosterCell row={row} />
        <ContactCell row={row} />
        <StagCell row={row} />
      </div>

      {(row.ai_cta_count ?? 0) > 0 && (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {open ? 'Hide' : 'Show'} CTA links
        </button>
      )}
      {open && (
        <div className="mt-2 border-t border-[color:var(--color-border)] pt-2">
          <CtaPanel profileId={row.id} domain={row.normalized_domain} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- cells ----

/** The headline number: how many outbound brand links this affiliate has,
 *  and how many a human has already walked for a tag. */
function CtaCount({ row }: { row: AffiliateRow }) {
  const n = row.ai_cta_count ?? 0
  if (n === 0) return <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">none</span>
  return (
    <span
      title={`${n} CTA link${n === 1 ? '' : 's'}${row.cta_checked > 0 ? `, ${row.cta_checked} already checked for an S-tag` : ''}`}
      className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[color:var(--color-text-primary)]"
    >
      <Link2 className="h-3 w-3 text-[color:var(--color-text-secondary)]" />
      {n}
      {row.cta_checked > 0 && (
        <span className="font-normal text-[color:var(--color-text-secondary)]">/{row.cta_checked}✓</span>
      )}
    </span>
  )
}

function RoosterCell({ row }: { row: AffiliateRow }) {
  const names = row.ai_rooster_brands ?? []
  if (names.length === 0 && row.tracker_hits === 0) {
    return <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">—</span>
  }
  const label = names.length > 0 ? names.slice(0, 2).join(', ') : `${row.tracker_hits} via tracker`
  return (
    <span
      title={names.length > 0 ? `Promotes: ${names.join(', ')}` : `${row.tracker_hits} CTA link(s) resolve through a Rooster tracker`}
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"
    >
      <ShieldCheck className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}{names.length > 2 ? ` +${names.length - 2}` : ''}</span>
    </span>
  )
}

function ContactCell({ row }: { row: AffiliateRow }) {
  const emails = row.ai_emails ?? []
  const hasPage = Boolean(row.ai_contact_page_url)
  if (emails.length === 0 && !hasPage) {
    return <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">—</span>
  }
  const title = emails.length > 0 ? emails.join(', ') : (row.ai_contact_page_url ?? '')
  const body = emails.length > 0 ? (emails[0] ?? '') : 'contact page'
  return row.ai_contact_page_url && emails.length === 0 ? (
    <a
      href={row.ai_contact_page_url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex max-w-full items-center gap-1 truncate text-[11.5px] text-[color:var(--color-text-primary)] underline-offset-2 hover:underline"
    >
      <Mail className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />
      <span className="truncate">{body}</span>
    </a>
  ) : (
    <span title={title} className="inline-flex max-w-full items-center gap-1 truncate text-[11.5px] text-[color:var(--color-text-primary)]">
      <Mail className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />
      <span className="truncate">{body}</span>
    </span>
  )
}

function StagCell({ row }: { row: AffiliateRow }) {
  const total = row.ai_cta_count ?? 0
  if (row.manual_stag_status !== 'pending' && row.cta_checked === 0) {
    return <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">—</span>
  }
  const done = row.cta_checked >= total && total > 0
  return (
    <span
      title={done ? 'Every CTA link has been walked' : `${row.cta_checked} of ${total} CTA links walked in the browser`}
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        done ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900',
      ].join(' ')}
    >
      <Tag className="h-3 w-3" />
      {done ? 'done' : `${row.cta_checked}/${total}`}
    </span>
  )
}

function LastSeen({ iso, bands, nowMs }: { iso: string | null; bands: RecencyBands; nowMs: number }) {
  const band = recencyBand(iso, bands, nowMs)
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[color:var(--color-text-secondary)]" title={RECENCY_LABEL[band]}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${RECENCY_DOT[band]}`} />
      {formatDaysAgo(daysSince(iso, nowMs))}
    </span>
  )
}

// ------------------------------------------------------------ CTA panel ----

/** Loads a site's CTA links on demand — 800 links across the table would be a
 *  lot to ship when most rows are never expanded. */
function CtaPanel({ profileId, domain }: { profileId: number; domain: string }) {
  const [links, setLinks] = useState<CtaLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/affiliates/cta?profile_id=${profileId}`, { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { links: CtaLink[] }
        if (!cancelled) setLinks(body.links ?? [])
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [profileId])

  if (error) return <p className="text-[11.5px] text-red-700">Could not load CTA links: {error}</p>
  if (links === null) return <p className="text-[11.5px] text-[color:var(--color-text-secondary)]">Loading CTA links…</p>
  if (links.length === 0) return <p className="text-[11.5px] text-[color:var(--color-text-secondary)]">No CTA links found on {domain}.</p>

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
        {links.length} CTA link{links.length === 1 ? '' : 's'} — where each one actually lands
      </div>
      <ul className="flex flex-col gap-1">
        {links.map(l => (
          <li
            key={l.id}
            className="flex flex-col gap-0.5 rounded-sm bg-[color:var(--color-bg-primary)] px-2 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[12px] font-medium text-[color:var(--color-text-primary)]">
                {l.brand_name ?? '(unattributed)'}
              </span>
              {l.is_rooster_brand && (
                <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-emerald-800">
                  ours
                </span>
              )}
              {l.stag_found && (
                <span className="shrink-0 rounded-full bg-sky-100 px-1.5 py-0.5 text-[9.5px] font-semibold text-sky-800" title="S-tag captured">
                  {l.stag_found}
                </span>
              )}
            </span>
            <span className="min-w-0 text-[11px] text-[color:var(--color-text-secondary)]">
              <span className="font-mono">{l.cta_url.length > 34 ? l.cta_url.slice(0, 34) + '…' : l.cta_url}</span>
              <span className="mx-1">→</span>
              <span className={l.is_rooster_tracker ? 'font-semibold text-emerald-700' : ''}>
                {l.resolved_host ?? 'unresolved'}
              </span>
              {l.is_rooster_tracker && <span className="ml-1 text-emerald-700">(Rooster tracker)</span>}
              {l.unmask_status && l.unmask_status !== 'ok' && (
                <span className="ml-1 text-amber-700">· {l.unmask_status}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --------------------------------------------------------------- atoms ----

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={[
        'whitespace-nowrap border-b border-[color:var(--color-border-strong)] bg-[color:var(--color-border-strong)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={['px-3 py-2 align-middle', className ?? ''].join(' ')}>{children}</td>
}
