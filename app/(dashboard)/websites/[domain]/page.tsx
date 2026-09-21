import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { RECENCY_DOT, RECENCY_LABEL } from '@/lib/website-profiles/recency'
import {
  loadWebsiteEnrichment,
  loadWebsiteSummary,
  type WebsiteSummary,
} from '../_lib/query'
import { WebsiteActions, WebsiteFacts } from '../_components/website-detail'
import { Appearances } from '../_components/appearances'

export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ domain: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Where "Back" goes.
 *
 * You almost always arrive here from a batch, so returning to /leads
 * dropped you somewhere you had not been. The table hands us the page
 * you left in `?from=`; failing that (a pasted link, a bookmark) we send
 * you to the batch that produced the newest appearance, which is the
 * closest thing to "where this came from". /leads is the last resort.
 *
 * Only same-origin paths are honoured — an absolute URL in `from` would
 * turn this into an open redirect.
 */
function backTarget(
  fromParam: string | string[] | undefined,
  newestJobId: string | null,
): { href: string; label: string } {
  const raw = typeof fromParam === 'string' ? fromParam : null
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) {
    return {
      href: raw,
      label: raw.startsWith('/scrape/')
        ? 'Back to batch'
        : raw.startsWith('/leads')
          ? 'Back to leads'
          : 'Back',
    }
  }
  if (newestJobId) return { href: `/scrape/${newestJobId}`, label: 'Back to batch' }
  return { href: '/leads', label: 'Back to leads' }
}

/**
 * One page per website.
 *
 * Reads top to bottom the way the question is actually asked: what is
 * this site, what did we conclude about it, where have we seen it, and
 * then the evidence behind the conclusions. Every band runs the full
 * width — an operator opens this on a wide screen and the old narrow
 * column wasted most of it.
 */
export default async function WebsitePage({ params, searchParams }: Props) {
  const { domain: raw } = await params
  const sp = await searchParams
  const site = await loadWebsiteSummary(raw)
  const { profile, domain, appearances, leadIds, primaryLeadId, recency, lastSeenAt } = site

  // Nothing at all — no profile row AND no lead has ever mentioned it.
  if (!domain || (!profile && appearances.length === 0)) notFound()

  const count = profile?.appearance_count ?? appearances.length
  const back = backTarget(sp.from, appearances[0]?.scrape_job_id ?? null)

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
      <div>
        <Link
          href={back.href}
          className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <ArrowLeft className="h-3 w-3" />
          {back.label}
        </Link>
      </div>

      <header className="flex flex-col gap-3 border-b border-[color:var(--color-border)] pb-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <h1 className="flex min-w-0 items-center gap-2 text-[20px] font-semibold text-[color:var(--color-text-primary)]">
              <span
                aria-hidden
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${RECENCY_DOT[recency]}`}
                title={RECENCY_LABEL[recency]}
              />
              <span className="truncate">{domain}</span>
            </h1>
            <p className="mt-1 max-w-[80ch] text-[13px] text-[color:var(--color-text-secondary)]">
              {profile?.ai_site_description ?? (
                <span className="italic opacity-70">No description yet.</span>
              )}
            </p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--color-text-secondary)]">
              <span>
                {count.toLocaleString()} appearance{count === 1 ? '' : 's'}
              </span>
              {profile?.first_seen_at && (
                <>· <span>first seen {new Date(profile.first_seen_at).toLocaleDateString()}</span></>
              )}
              {lastSeenAt && (
                <>· <span>last seen {new Date(lastSeenAt).toLocaleDateString()}</span></>
              )}
              {profile?.system_flag && (
                <span
                  className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-700"
                  title={profile.system_flag_reason ?? undefined}
                >
                  {profile.system_flag}
                </span>
              )}
            </p>
          </div>
          <a
            href={`https://${domain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Visit site
          </a>
        </div>

        {/* The actions belong beside the identity, not stacked above the
            content as three panels of explanatory prose. They need the
            enriched lead, so they stream in with it. */}
        <Suspense fallback={<ActionsSkeleton />}>
          <ActionsSlot primaryLeadId={primaryLeadId} leadIds={leadIds} domain={domain} />
        </Suspense>
      </header>

      <Verdicts site={site} />

      <section className="min-w-0">
        {/* A site like gambling.com has thousands of appearances; the query
            caps at 500, so say which number you're looking at rather than
            quietly showing the cap as if it were the total. */}
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Appearances (
          {count > appearances.length
            ? `newest ${appearances.length.toLocaleString()} of ${count.toLocaleString()}`
            : appearances.length.toLocaleString()}
          )
        </h2>
        <Appearances rows={appearances} />
      </section>

      <section className="min-w-0">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Details
        </h2>
        <Suspense fallback={<FactsSkeleton />}>
          <FactsSlot primaryLeadId={primaryLeadId} />
        </Suspense>
      </section>
    </div>
  )
}

/**
 * The answers, before the evidence.
 *
 * Six tiles across the full width: whether the site is already ours,
 * whether it is on keyword, and the four enrichment verdicts. An
 * unanswered question says so rather than showing a bare dash.
 */
function Verdicts({ site }: { site: WebsiteSummary }) {
  const { profile, appearances } = site
  // Every verdict below is denormalized onto the profile, so the tiles
  // paint with the first two queries rather than waiting on enrichment.
  const isAffiliate = profile?.is_affiliate ?? null
  const isRooster = profile?.is_rooster_partner ?? null

  // "Already exists" reads the same way it does on the batch table:
  // Monday wins because it names the board, otherwise our own history.
  const onMonday = profile?.is_on_monday === true
  const board = profile?.monday_board ?? null
  const seenBefore = appearances.length > 1
  const exists = onMonday
    ? { label: board ? `Monday · ${board}` : 'On Monday', tone: 'muted' as const }
    : seenBefore
      ? { label: 'In system', tone: 'warn' as const }
      : { label: 'New', tone: 'good' as const }

  const relevantCount = appearances.filter(a => a.is_relevant === true).length
  const offCount = appearances.filter(a => a.is_relevant === false).length
  const relevance =
    relevantCount === 0 && offCount === 0
      ? { label: 'Not screened', tone: 'idle' as const }
      : offCount > relevantCount
        ? { label: 'Off keyword', tone: 'bad' as const }
        : { label: 'On keyword', tone: 'good' as const }


  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Tile label="Already exists?" value={exists.label} tone={exists.tone} />
      <Tile label="Relevant?" value={relevance.label} tone={relevance.tone} />
      <Tile
        label="Affiliate?"
        value={isAffiliate === null ? 'Unchecked' : isAffiliate ? 'Yes' : 'No'}
        tone={isAffiliate === true ? 'good' : isAffiliate === false ? 'muted' : 'idle'}
      />
      <Tile
        label="Rooster brand?"
        value={
          isRooster === true ? (profile?.brand ?? 'Yes') : isRooster === false ? 'No' : 'Unchecked'
        }
        tone={isRooster === true ? 'good' : isRooster === false ? 'muted' : 'idle'}
      />
      <Tile
        label="Contacts"
        value={
          profile?.has_contact_details === true
            ? 'Found'
            : profile?.has_contact_details === false
              ? 'None found'
              : 'Unchecked'
        }
        tone={profile?.has_contact_details === true ? 'good' : 'idle'}
      />
      <Tile
        label="S-tags"
        value={profile?.has_s_tags === true ? 'Found' : profile?.has_s_tags === false ? 'None' : 'Unchecked'}
        tone={profile?.has_s_tags === true ? 'good' : 'idle'}
      />
    </div>
  )
}

/**
 * The streamed half.
 *
 * loadLeadDetail is three round trips, a cohort RPC, a Monday-candidate
 * search and a signed URL per screenshot. Held in front of the page that
 * was ~3.6s to first byte; behind a boundary the header, tiles and
 * appearances paint straight away and these fill in.
 */
async function ActionsSlot({
  primaryLeadId,
  leadIds,
  domain,
}: {
  primaryLeadId: number | null
  leadIds: number[]
  domain: string
}) {
  const detail = await loadWebsiteEnrichment(primaryLeadId)
  if (!detail) return null
  return <WebsiteActions detail={detail} leadIds={leadIds} domain={domain} />
}

async function FactsSlot({ primaryLeadId }: { primaryLeadId: number | null }) {
  const detail = await loadWebsiteEnrichment(primaryLeadId)
  if (!detail) {
    return (
      <p className="text-[12px] text-[color:var(--color-text-secondary)]">
        No enrichment has run for this website yet.
      </p>
    )
  }
  return <WebsiteFacts detail={detail} />
}

function ActionsSkeleton() {
  return (
    <div className="flex gap-2" aria-hidden>
      <div className="h-8 w-32 animate-pulse rounded-md bg-[color:var(--color-bg-secondary)]" />
      <div className="h-8 w-36 animate-pulse rounded-md bg-[color:var(--color-bg-secondary)]" />
      <div className="h-8 w-32 animate-pulse rounded-md bg-[color:var(--color-bg-secondary)]" />
    </div>
  )
}

function FactsSkeleton() {
  return (
    <div className="columns-1 gap-4 lg:columns-2 2xl:columns-3 [&>*]:mb-4" aria-hidden>
      {[28, 20, 24].map((h, i) => (
        <div
          key={i}
          className="animate-pulse rounded-md bg-[color:var(--color-bg-secondary)]"
          style={{ height: `${h * 4}px` }}
        />
      ))}
    </div>
  )
}

const TILE_TONES = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  bad: 'border-rose-200 bg-rose-50 text-rose-900',
  muted: 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]',
  idle: 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)]',
} as const

function Tile({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: keyof typeof TILE_TONES
}) {
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-2 ${TILE_TONES[tone]}`}>
      <p className="text-[9px] font-semibold uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-0.5 truncate text-[14px] font-semibold" title={value}>
        {value}
      </p>
    </div>
  )
}
