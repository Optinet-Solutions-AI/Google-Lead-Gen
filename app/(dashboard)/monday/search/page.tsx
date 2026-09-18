import Link from 'next/link'
import { ArrowUpRight, Clock3, Database, Globe, Link2, Search, ShieldAlert } from 'lucide-react'
import { formatCet } from '@/lib/website-profiles/cet'
import {
  RECENCY_DOT,
  RECENCY_LABEL,
  RECENCY_PILL,
  daysSince,
  formatDaysAgo,
  recencyBand,
  type RecencyBands,
} from '@/lib/website-profiles/recency'
import {
  BOARD_LABEL,
  BOARD_SLUG,
  MATCH_LABEL,
  loadMirrorFreshness,
  loadRecencyBands,
  requestNowMs,
  searchDomain,
  type MirrorFreshness,
  type ProfileCard,
  type SearchResult,
} from './_lib/search'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

/**
 * /monday/search — ask "does Monday.com know this website?" against our
 * mirror of the four boards. Shows every matching item (not just the first),
 * how it matched, when our copy of Monday was last refreshed (CET), and
 * what our own website profile says.
 */
export default async function MondaySearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const q = typeof sp.q === 'string' ? sp.q.trim() : ''
  const nowMs = requestNowMs()

  const [freshness, bands, result] = await Promise.all([
    loadMirrorFreshness(),
    loadRecencyBands(),
    q ? searchDomain(q) : Promise.resolve<SearchResult | null>(null),
  ])

  const newest = freshness.reduce<string | null>((acc, f) => {
    if (!f.last_synced_at) return acc
    return !acc || f.last_synced_at > acc ? f.last_synced_at : acc
  }, null)

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">Search Monday.com</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-[color:var(--color-text-secondary)]">
            Type a website. We look through our copy of all four Monday boards and their updates — exact
            website, item title, other hosts of the same domain, the same brand on another TLD, and
            mentions inside item updates.
          </p>
        </div>
        <MirrorStamp newest={newest} />
      </header>

      <form method="get" action="/monday/search" className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-secondary)]" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="casinoreviews.co.uk or https://www.example.com/page"
            autoFocus
            className="w-full rounded-lg border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-primary)] py-2.5 pl-10 pr-3 text-[14px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[color:var(--color-text-primary)] px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90"
        >
          Search
        </button>
      </form>

      <FreshnessRow freshness={freshness} />

      {result && <Results result={result} bands={bands} nowMs={nowMs} />}
    </section>
  )
}

function MirrorStamp({ newest }: { newest: string | null }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-secondary)]">
      <Clock3 className="h-3.5 w-3.5" />
      <span>
        Our copy of Monday last updated{' '}
        <span className="font-semibold text-[color:var(--color-text-primary)]">{formatCet(newest)}</span>
      </span>
    </div>
  )
}

function FreshnessRow({ freshness }: { freshness: MirrorFreshness[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {freshness.map(f => (
        <div key={f.board} className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
            {BOARD_LABEL[f.board] ?? f.board}
          </div>
          <div className="mt-0.5 text-[12.5px] text-[color:var(--color-text-primary)]">
            {f.items.toLocaleString()} items · {f.updates.toLocaleString()} updates
          </div>
          <div className="mt-0.5 text-[11px] text-[color:var(--color-text-secondary)]" title="When this board was last copied from Monday (CET)">
            Copied {formatCet(f.last_synced_at)}
          </div>
        </div>
      ))}
    </div>
  )
}

function Results({ result, bands, nowMs }: { result: SearchResult; bands: RecencyBands; nowMs: number }) {
  if (!result.normalized) {
    return (
      <Empty title="That does not look like a website" body="Try a domain like example.com or paste a full URL." />
    )
  }

  const onMonday = result.hits.length > 0
  return (
    <div className="flex flex-col gap-4">
      {/* Verdict line */}
      <div
        className={[
          'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3',
          onMonday ? 'border-emerald-200 bg-emerald-50' : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]',
        ].join(' ')}
      >
        <Globe className={`h-5 w-5 ${onMonday ? 'text-emerald-700' : 'text-[color:var(--color-text-secondary)]'}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-[color:var(--color-text-primary)]">{result.normalized}</div>
          <div className={`text-[12px] ${onMonday ? 'text-emerald-800' : 'text-[color:var(--color-text-secondary)]'}`}>
            {onMonday
              ? `Already on Monday.com — ${result.hits.length} matching item${result.hits.length === 1 ? '' : 's'}`
              : 'Not found on any Monday board or update'}
          </div>
        </div>
        {result.profile && <RecencyPill iso={result.profile.last_seen_at} bands={bands} nowMs={nowMs} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* Monday matches */}
        <section className="min-w-0 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
          <header className="flex items-center justify-between gap-2 border-b border-[color:var(--color-border)] px-4 py-2.5">
            <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">Monday.com items</h2>
            <span className="text-[11px] text-[color:var(--color-text-secondary)]">{result.hits.length} found</span>
          </header>
          {result.hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12.5px] text-[color:var(--color-text-secondary)]">Nothing on Monday matches this website.</p>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {result.hits.map(h => (
                <li key={`${h.board}-${h.item_id}`} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-start sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <BoardChip board={h.board} />
                      <Link
                        href={`/monday/${BOARD_SLUG[h.board] ?? h.board}?item=${encodeURIComponent(h.item_id)}`}
                        className="inline-flex min-w-0 items-center gap-1 truncate text-[13px] font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline"
                        title="Open this item in Monday Data"
                      >
                        <span className="truncate">{h.item_name ?? h.item_id}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-text-secondary)]" />
                      </Link>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[color:var(--color-text-secondary)]">
                      {MATCH_LABEL[h.match_kind] ?? h.match_kind}
                      {h.website ? <> · website <span className="font-mono">{h.website}</span></> : null}
                    </div>
                  </div>
                  <div className="shrink-0 text-[11px] text-[color:var(--color-text-secondary)] sm:text-right">
                    <div title="Last change on Monday (CET)">Monday: {formatCet(h.monday_updated_at)}</div>
                    <div title="When our copy of this item was refreshed (CET)">Copied: {formatCet(h.synced_at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Our profile */}
        <section className="min-w-0 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
          <header className="flex items-center justify-between gap-2 border-b border-[color:var(--color-border)] px-4 py-2.5">
            <h2 className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
              <Database className="h-3.5 w-3.5" /> Our website profile
            </h2>
            {result.profile && (
              <span className="text-[11px] text-[color:var(--color-text-secondary)]">
                updated {formatCet(result.profile.updated_at)}
              </span>
            )}
          </header>
          {result.profile ? (
            <ProfileBody profile={result.profile} result={result} bands={bands} nowMs={nowMs} />
          ) : (
            <p className="px-4 py-6 text-center text-[12.5px] text-[color:var(--color-text-secondary)]">
              We have never scraped this website and Monday does not list it, so there is no profile yet.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

function ProfileBody({ profile, result, bands, nowMs }: { profile: ProfileCard; result: SearchResult; bands: RecencyBands; nowMs: number }) {
  const lastSeenDays = daysSince(profile.last_seen_at, nowMs)
  return (
    <div className="flex flex-col divide-y divide-[color:var(--color-border)]">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 text-[12.5px]">
        <Field label="Last seen on a scrape">
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${RECENCY_DOT[recencyBand(profile.last_seen_at, bands, nowMs)]}`} />
            {profile.last_seen_at ? `${formatCet(profile.last_seen_at)} (${formatDaysAgo(lastSeenDays)})` : 'never'}
          </span>
        </Field>
        <Field label="Times seen">{profile.appearance_count.toLocaleString()}</Field>
        <Field label="First seen">{formatCet(profile.first_seen_at)}</Field>
        <Field label="Lead rows">
          {result.leadCount > 0 ? (
            <Link href={`/leads?q=${encodeURIComponent(profile.normalized_domain)}&show_hidden=1`} className="underline underline-offset-2">
              {result.leadCount.toLocaleString()} in the leads table
            </Link>
          ) : (
            'none'
          )}
        </Field>
        <Field label="Already on Monday.com">
          {profile.is_on_monday ? (
            <span>
              Yes · <BoardChip board={profile.monday_board ?? ''} /> {MATCH_LABEL[profile.monday_match_kind ?? ''] ?? profile.monday_match_kind}
            </span>
          ) : (
            'No'
          )}
          <div className="text-[11px] text-[color:var(--color-text-secondary)]">checked {formatCet(profile.monday_matched_at)}</div>
        </Field>
        <Field label="Status">
          <div className="flex flex-wrap gap-1">
            {profile.is_not_relevant && (
              <Pill cls="bg-amber-100 text-amber-900" title={`Marked not relevant (${profile.not_relevant_source ?? 'unknown'})`}>
                Not relevant · {profile.not_relevant_source ?? '?'}
              </Pill>
            )}
            {profile.system_flag && (
              <Pill cls="bg-slate-200 text-slate-800" title={profile.system_flag_reason ?? ''}>
                <ShieldAlert className="h-3 w-3" /> System flag · {profile.system_flag.replace(/_/g, ' ')}
              </Pill>
            )}
            {!profile.is_not_relevant && !profile.system_flag && <span className="text-[color:var(--color-text-secondary)]">Active</span>}
          </div>
        </Field>
      </dl>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 text-[12.5px]">
        <Verdict label="Affiliate" value={profile.is_affiliate} checkedAt={profile.affiliate_checked_at} overriddenAt={profile.is_affiliate_overridden_at} extra={profile.affiliate_confidence} bands={bands} nowMs={nowMs} />
        <Verdict label="Rooster partner" value={profile.is_rooster_partner} checkedAt={profile.rooster_checked_at} overriddenAt={profile.is_rooster_overridden_at} extra={profile.brand} bands={bands} nowMs={nowMs} />
        <Verdict label="Contact details" value={profile.has_contact_details} checkedAt={profile.contact_checked_at} overriddenAt={null} extra={null} bands={bands} nowMs={nowMs} />
        <Verdict label="S-tags" value={profile.has_s_tags} checkedAt={profile.s_tags_checked_at} overriddenAt={null} extra={null} bands={bands} nowMs={nowMs} />
      </dl>

      {result.related.length > 0 && (
        <div className="px-4 py-3">
          <div className="mb-1.5 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
            <Link2 className="h-3 w-3" /> Possible duplicates / related websites
          </div>
          <ul className="flex flex-col gap-1">
            {result.related.slice(0, 12).map(r => (
              <li key={`${r.id}-${r.relation}`} className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <Link href={`/monday/search?q=${encodeURIComponent(r.normalized_domain)}`} className="font-medium text-[color:var(--color-text-primary)] underline-offset-2 hover:underline">
                  {r.normalized_domain}
                </Link>
                <span className="text-[11px] text-[color:var(--color-text-secondary)]">
                  {r.relation === 'same_registered_domain' ? 'same domain, other host' : r.relation === 'same_brand_stem' ? 'same brand, other TLD' : r.relation}
                  {r.is_on_monday ? ' · on Monday' : ''}
                  {r.last_seen_at ? ` · seen ${formatDaysAgo(daysSince(r.last_seen_at, nowMs))}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.appearances.length > 0 && (
        <div className="px-4 py-3">
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">Recent appearances</div>
          <ul className="flex flex-col gap-1">
            {result.appearances.map((a, i) => (
              <li key={`${a.seen_at}-${i}`} className="flex flex-wrap items-center gap-x-2 text-[12px] text-[color:var(--color-text-primary)]">
                <span className="tabular-nums text-[color:var(--color-text-secondary)]">{formatCet(a.seen_at)}</span>
                <span className="font-medium">{a.keyword ?? '—'}</span>
                <span className="text-[color:var(--color-text-secondary)]">
                  {[a.country_code, a.search_engine, a.result_type].filter(Boolean).join(' · ')}
                </span>
                {a.batch_id != null && (
                  <Link href={`/leads?batch_id=${a.batch_id}&show_hidden=1`} className="text-[11px] text-[color:var(--color-text-secondary)] underline-offset-2 hover:underline">
                    batch {a.batch_id}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Verdict({
  label, value, checkedAt, overriddenAt, extra, bands, nowMs,
}: {
  label: string
  value: boolean | null
  checkedAt: string | null
  overriddenAt: string | null
  extra: string | null
  bands: RecencyBands
  nowMs: number
}) {
  const band = recencyBand(checkedAt, bands, nowMs)
  return (
    <Field label={label}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={value === true ? 'font-semibold text-emerald-700' : value === false ? 'text-[color:var(--color-text-secondary)]' : 'text-[color:var(--color-text-secondary)]'}>
          {value === true ? 'Yes' : value === false ? 'No' : 'Unknown'}
        </span>
        {extra && <span className="text-[11px] text-[color:var(--color-text-secondary)]">{extra}</span>}
        {overriddenAt && <Pill cls="bg-sky-100 text-sky-800" title={`Set by an operator ${formatCet(overriddenAt)}`}>manual</Pill>}
      </div>
      <div className="text-[11px] text-[color:var(--color-text-secondary)]" title={RECENCY_LABEL[band]}>
        {checkedAt ? (
          <span className="inline-flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${RECENCY_DOT[band]}`} /> checked {formatDaysAgo(daysSince(checkedAt, nowMs))}
          </span>
        ) : (
          'never checked'
        )}
      </div>
    </Field>
  )
}

function RecencyPill({ iso, bands, nowMs }: { iso: string | null; bands: RecencyBands; nowMs: number }) {
  const band = recencyBand(iso, bands, nowMs)
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium ${RECENCY_PILL[band]}`} title={RECENCY_LABEL[band]}>
      <span className={`h-1.5 w-1.5 rounded-full ${RECENCY_DOT[band]}`} />
      {iso ? `Last seen ${formatDaysAgo(daysSince(iso, nowMs))}` : 'Never on a scrape'}
    </span>
  )
}

function BoardChip({ board }: { board: string }) {
  const cls =
    board === 'affiliates' ? 'bg-emerald-100 text-emerald-800'
    : board === 'not_relevant_leads' ? 'bg-amber-100 text-amber-900'
    : board === 'email_undelivered_leads' ? 'bg-rose-100 text-rose-800'
    : 'bg-sky-100 text-sky-800'
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${cls}`}>{BOARD_LABEL[board] ?? board}</span>
}

function Pill({ children, cls, title }: { children: React.ReactNode; cls: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${cls}`}>
      {children}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-text-primary)]">{children}</dd>
    </div>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)]/40 px-4 py-8 text-center">
      <p className="text-[13px] font-medium text-[color:var(--color-text-primary)]">{title}</p>
      <p className="text-[12px] text-[color:var(--color-text-secondary)]">{body}</p>
    </div>
  )
}
