import { getShadowContext } from '@/lib/shadow-filter'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

type SearchParams = Record<string, string | string[] | undefined>

type Props = {
  searchParams: Promise<SearchParams>
}

type LogRow = {
  id: number
  user_email: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
}

export default async function ActivityPage({ searchParams }: Props) {
  const sp = await searchParams
  const page = clampInt(sp.page, 1, 100_000, 1)
  const q = typeof sp.q === 'string' ? sp.q.trim() : ''
  const actionFilter = typeof sp.action === 'string' ? sp.action.trim() : ''

  const svc = createServiceClient()
  const shadowCtx = await getShadowContext()
  let query = svc
    .from('activity_log')
    .select('id, user_email, action, entity_type, entity_id, details, created_at', { count: 'exact' })

  // Shadow isolation. lib/activity-log.ts stamps user_is_shadow at
  // write time so the filter is a simple boolean check; shadow viewer
  // only sees their own user_email.
  if (shadowCtx.isShadow) {
    if (shadowCtx.email) {
      query = query.eq('user_email', shadowCtx.email)
    } else {
      // Defensive: no email → guaranteed-empty result rather than leak.
      query = query.eq('user_email', '__shadow_no_email__')
    }
  } else {
    query = query.eq('user_is_shadow', false)
  }

  if (actionFilter) {
    query = query.like('action', `${actionFilter}%`)
  }
  if (q) {
    const sanitized = q.replace(/[,()*]/g, '')
    query = query.or(
      [
        `user_email.ilike.%${sanitized}%`,
        `entity_id.ilike.%${sanitized}%`,
        `entity_type.ilike.%${sanitized}%`,
      ].join(','),
    )
  }

  query = query.order('created_at', { ascending: false })
  const from = (page - 1) * PAGE_SIZE
  query = query.range(from, from + PAGE_SIZE - 1)

  const { data, count, error } = await query
  if (error) throw error
  const rows = (data ?? []) as LogRow[]
  const total = count ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Activity log
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Every meaningful UI action — scrape enqueues, enrichment triggers, manual overrides,
          brand / schedule / profile edits, screenshot deletes. Newest first.
        </p>
      </header>

      <FilterBar currentAction={actionFilter} currentQ={q} />

      <p className="text-[11px] text-[color:var(--color-text-secondary)]">
        {total.toLocaleString()} entr{total === 1 ? 'y' : 'ies'}{' '}
        {actionFilter ? <>· filtered by <code>{actionFilter}*</code></> : null}
        {q ? <> · matching &quot;{q}&quot;</> : null}
      </p>

      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-[color:var(--color-border-strong)]">
            <tr>
              <Th>When</Th>
              <Th>User</Th>
              <Th>Action</Th>
              <Th>Entity</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-[12px] text-[color:var(--color-text-secondary)]">
                  No activity matches.
                </td>
              </tr>
            )}
            {rows.map(row => (
              <tr key={row.id} className="border-b border-[color:var(--color-border)] last:border-b-0">
                <Td className="whitespace-nowrap text-[color:var(--color-text-secondary)]">
                  <time dateTime={row.created_at}>{formatTs(row.created_at)}</time>
                </Td>
                <Td className="whitespace-nowrap">{row.user_email ?? '—'}</Td>
                <Td>
                  <ActionBadge action={row.action} />
                </Td>
                <Td className="whitespace-nowrap text-[color:var(--color-text-secondary)]">
                  {row.entity_type ? (
                    <>
                      <span className="text-[color:var(--color-text-primary)]">{row.entity_type}</span>
                      {row.entity_id ? <> · {row.entity_id.length > 30 ? row.entity_id.slice(0, 30) + '…' : row.entity_id}</> : null}
                    </>
                  ) : '—'}
                </Td>
                <Td className="max-w-[460px] truncate text-[color:var(--color-text-secondary)]" title={JSON.stringify(row.details ?? {})}>
                  {row.details ? formatDetails(row.action, row.details) : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} q={q} actionFilter={actionFilter} />}
    </div>
  )
}

function FilterBar({ currentAction, currentQ }: { currentAction: string; currentQ: string }) {
  const PRESETS: Array<{ label: string; value: string }> = [
    { label: 'All', value: '' },
    { label: 'Scrape', value: 'scrape.' },
    { label: 'Enrichment', value: 'enrichment.' },
    { label: 'Override', value: 'override.' },
    { label: 'Brand', value: 'brand.' },
    { label: 'Schedule', value: 'schedule.' },
    { label: 'Profile', value: 'profile.' },
    { label: 'Screenshot', value: 'screenshot.' },
  ]
  return (
    <form method="get" className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(p => {
          const active = currentAction === p.value
          const href = p.value
            ? `/activity?action=${encodeURIComponent(p.value)}${currentQ ? `&q=${encodeURIComponent(currentQ)}` : ''}`
            : `/activity${currentQ ? `?q=${encodeURIComponent(currentQ)}` : ''}`
          return (
            <a
              key={p.label}
              href={href}
              className={[
                'rounded-md border border-[color:var(--color-border)] px-2.5 py-1 text-[11px] font-medium hover:bg-[color:var(--color-bg-secondary)]',
                active ? 'bg-[color:var(--color-accent)] text-[color:var(--color-text-primary)]' : 'bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)]',
              ].join(' ')}
            >
              {p.label}
            </a>
          )
        })}
      </div>
      <input
        type="search"
        name="q"
        placeholder="Search user / entity"
        defaultValue={currentQ}
        className="ml-auto w-[240px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      {currentAction && <input type="hidden" name="action" value={currentAction} />}
      <button
        type="submit"
        className="rounded-md bg-[color:var(--color-accent)] px-3 py-1 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-hover)]"
      >
        Apply
      </button>
    </form>
  )
}

function Pagination({
  page,
  totalPages,
  q,
  actionFilter,
}: {
  page: number
  totalPages: number
  q: string
  actionFilter: string
}) {
  function href(p: number) {
    const params = new URLSearchParams()
    if (p > 1) params.set('page', String(p))
    if (q) params.set('q', q)
    if (actionFilter) params.set('action', actionFilter)
    const qs = params.toString()
    return qs ? `/activity?${qs}` : '/activity'
  }
  return (
    <div className="flex items-center justify-between text-[11px] text-[color:var(--color-text-secondary)]">
      <span>Page {page} of {totalPages}</span>
      <div className="flex gap-1">
        <a
          href={page > 1 ? href(page - 1) : undefined}
          aria-disabled={page <= 1}
          className={[
            'rounded-md border border-[color:var(--color-border)] px-3 py-1',
            page <= 1 ? 'pointer-events-none opacity-40' : 'hover:bg-[color:var(--color-bg-secondary)]',
          ].join(' ')}
        >
          Previous
        </a>
        <a
          href={page < totalPages ? href(page + 1) : undefined}
          aria-disabled={page >= totalPages}
          className={[
            'rounded-md border border-[color:var(--color-border)] px-3 py-1',
            page >= totalPages ? 'pointer-events-none opacity-40' : 'hover:bg-[color:var(--color-bg-secondary)]',
          ].join(' ')}
        >
          Next
        </a>
      </div>
    </div>
  )
}

const ACTION_FAMILY_STYLES: Record<string, string> = {
  scrape: 'bg-amber-100 text-amber-800',
  enrichment: 'bg-sky-100 text-sky-800',
  override: 'bg-rose-100 text-rose-800',
  brand: 'bg-purple-100 text-purple-800',
  schedule: 'bg-emerald-100 text-emerald-800',
  profile: 'bg-zinc-200 text-zinc-700',
  screenshot: 'bg-orange-100 text-orange-800',
}

function ActionBadge({ action }: { action: string }) {
  const family = action.split('.')[0] ?? ''
  const cls = ACTION_FAMILY_STYLES[family] ?? 'bg-zinc-200 text-zinc-700'
  return (
    <span className={['inline-block rounded-full px-2 py-0.5 text-[10px] font-medium', cls].join(' ')}>
      {action}
    </span>
  )
}

function formatDetails(action: string, details: Record<string, unknown>): string {
  switch (action) {
    case 'scrape.enqueue': {
      const c = details.country_code as string | undefined
      const k = details.keywords_count as number | undefined
      const we = details.with_enrichment as boolean | undefined
      const sa = details.scheduled_at as string | null | undefined
      const parts: string[] = []
      if (k != null) parts.push(`${k} keyword${k === 1 ? '' : 's'}`)
      if (c) parts.push(c)
      if (we) parts.push('with enrichment')
      if (sa) parts.push(`scheduled ${new Date(sa).toLocaleString()}`)
      return parts.join(' · ')
    }
    case 'enrichment.affiliate':
    case 'enrichment.rooster':
    case 'enrichment.contact':
    case 'enrichment.stag': {
      const e = details.enqueued as number | undefined
      const s = details.skipped as number | undefined
      return `${e ?? 0} enqueued${s ? ` · ${s} skipped` : ''}`
    }
    case 'enrichment.monday_dup_check':
    case 'enrichment.stag_dup_check': {
      const c = details.checked as number | undefined
      const m = details.matched as number | undefined
      return `${c ?? 0} checked · ${m ?? 0} matched`
    }
    case 'override.monday':
    case 'override.affiliate':
    case 'override.rooster':
    case 'override.contact':
    case 'override.stag':
    case 'override.stag_verified':
      return `value=${details.value ?? '?'}`
    default:
      return Object.entries(details)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' · ')
  }
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="sticky top-0 z-20 whitespace-nowrap border-b border-[color:var(--color-border-strong)] bg-[color:var(--color-border-strong)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]"
    >
      {children}
    </th>
  )
}

function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <td
      {...(title ? { title } : {})}
      className={['px-3 py-2 align-top text-[12px] text-[color:var(--color-text-primary)]', className ?? ''].join(' ')}
    >
      {children}
    </td>
  )
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

function clampInt(raw: string | string[] | undefined, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}
