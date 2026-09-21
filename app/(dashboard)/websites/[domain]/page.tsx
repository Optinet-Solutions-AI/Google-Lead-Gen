import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { RECENCY_DOT, RECENCY_LABEL } from '@/lib/website-profiles/recency'
import { loadWebsiteDetail } from '../_lib/query'
import { WebsiteDetailBody } from '../_components/website-detail'
import { Appearances } from '../_components/appearances'

export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ domain: string }>
}

/**
 * One page per website.
 *
 * Clicking a domain used to open a drawer over the table, which meant the
 * page you were looking at was a lead row while the thing you were reading
 * was a website. This is the website: its verdicts, its contacts, its
 * s-tags, and the list of SERPs it has turned up in.
 */
export default async function WebsitePage({ params }: Props) {
  const { domain: raw } = await params
  const { profile, domain, appearances, leadIds, detail, recency, lastSeenAt } =
    await loadWebsiteDetail(raw)

  // Nothing at all — no profile row AND no lead has ever mentioned it.
  if (!domain || (!profile && appearances.length === 0)) notFound()

  const count = profile?.appearance_count ?? appearances.length

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <div>
        <Link
          href="/leads"
          className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to leads
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex min-w-0 items-center gap-2 text-[18px] font-semibold text-[color:var(--color-text-primary)]">
            <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${RECENCY_DOT[recency]}`} title={RECENCY_LABEL[recency]} />
            <span className="truncate">{domain}</span>
          </h1>
          {profile?.ai_site_description && (
            <p className="mt-1 max-w-[70ch] text-[13px] text-[color:var(--color-text-secondary)]">
              {profile.ai_site_description}
            </p>
          )}
          <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
            {count.toLocaleString()} appearance{count === 1 ? '' : 's'}
            {profile?.first_seen_at && (
              <> · first seen {new Date(profile.first_seen_at).toLocaleDateString()}</>
            )}
            {lastSeenAt && <> · last seen {new Date(lastSeenAt).toLocaleDateString()}</>}
          </p>
          {profile?.system_flag && (
            <p
              className="mt-1.5 inline-block rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-700"
              title={profile.system_flag_reason ?? undefined}
            >
              {profile.system_flag}
            </p>
          )}
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
      </header>

      {/* Two columns on a wide screen: the verdicts and actions are what
          you act on, the appearance log is what you scan. */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="min-w-0">
          {detail ? (
            <WebsiteDetailBody detail={detail} leadIds={leadIds} domain={domain} />
          ) : (
            <p className="text-[12px] text-[color:var(--color-text-secondary)]">
              No enrichment has run for this website yet.
            </p>
          )}
        </div>

        <section className="min-w-0">
          {/* A site like gambling.com has thousands of appearances; the
              query caps at 500, so say which number you're looking at
              rather than quietly showing the cap as if it were the total. */}
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Appearances (
            {count > appearances.length
              ? `newest ${appearances.length.toLocaleString()} of ${count.toLocaleString()}`
              : appearances.length.toLocaleString()}
            )
          </h2>
          <Appearances rows={appearances} />
        </section>
      </div>
    </div>
  )
}
