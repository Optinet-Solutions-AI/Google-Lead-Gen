import type { ReactNode } from 'react'
import {
  CheckCircle2,
  ExternalLink,
  Globe,
  Mail,
  MessageCircle,
  Send,
  Sparkles,
  XCircle,
} from 'lucide-react'
import type { FbAdvertiserRow } from '../_lib/queries'

/**
 * Per-advertiser results table for Facebook Ad Library jobs (Phase 3). New lead
 * candidates first, then affiliates, showing the niche score + NEW badge, the
 * active-ad count, contacts mined from the ad copy, the Page website, and the
 * ad landing/CTA affiliate links that drove the flag. Server component.
 *
 * Sibling of x-creators-table.tsx. The Advertiser link is whatever the scraper
 * stored in page_url — the single source of truth, identical to what's pushed
 * to Monday + exports, so every surface opens the same working page. The
 * scraper builds a COUNTRY-SCOPED Ad Library NAME SEARCH for the advertiser
 * (…/ads/library/?country=AU&q={page_name}&search_type=keyword_unordered). We
 * do NOT deep-link by view_all_page_id={page_id}: FB's results grid no longer
 * exposes a real Ad Library Page id per card, and the numeric id we capture is
 * usually a personal-PROFILE id (fake-name gambling advertisers), which the
 * Ad Library doesn't match → the blank "no ads / isn't running ads in the
 * selected country" empty state (the "Ad Library appears blank for each result"
 * QA report, batches 1636 + 1741). The name search always re-surfaces the
 * advertiser — that's how we found them. See fb_adlibrary_search.py.
 */
export function FbAdvertisersTable({ rows }: { rows: FbAdvertiserRow[] }) {
  if (rows.length === 0) return null

  return (
    <div className="rounded-lg border border-[color:var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-[color:var(--color-bg-secondary)]">
          <tr className="text-left text-[11px] text-[color:var(--color-text-secondary)] [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:border-b [&>th]:border-[color:var(--color-border)] [&>th]:bg-[color:var(--color-bg-secondary)]">
            <th className="px-3 py-2 font-medium text-right tabular-nums">#</th>
            <th className="px-3 py-2 font-medium">Advertiser</th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Affiliate likelihood + niche score (0–100). “affiliate” = scored ≥30 (or runs an ad to a casino directly). NEW = a likely affiliate whose affiliate ID / Page name isn’t on Monday yet. Hover a badge for the breakdown."
            >
              Affiliate
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Monday recognition. Green ✓ = the Page name / affiliate ID / any of its ad links is already on a Monday board. Grey ✕ = we checked and found no match (worth reviewing for outreach). Blank = scoring hasn’t run yet."
            >
              On Monday
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Outreach contacts mined from the sampled ad copy — priority email › Telegram › Discord. Run “Score & check” to populate."
            >
              Contact
            </th>
            <th className="px-3 py-2 font-medium text-right">Active ads</th>
            <th className="px-3 py-2 font-medium">Website</th>
            <th className="px-3 py-2 font-medium">Casino partners / ad links</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <FbAdvertiserRowView key={r.id} r={r} n={i + 1} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FbAdvertiserRowView({ r, n }: { r: FbAdvertiserRow; n: number }) {
  const niche = r.niche_score == null ? null : Number(r.niche_score)
  const adCount = r.total_active_ads ?? r.ad_count

  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-0 align-top">
      <td className="px-3 py-2 text-right tabular-nums text-[color:var(--color-text-secondary)]">{n}</td>
      <td className="px-3 py-2">
        <a
          href={r.page_url}
          target="_blank"
          rel="noreferrer"
          title="Opens this advertiser's ads in the Ad Library (name search scoped to the job country) — these thin ad-only Pages show nothing on the profile, but their gambling ads surface here."
          className="inline-flex items-center gap-1 font-medium text-[color:var(--color-text-primary)] hover:underline"
        >
          {r.page_name}
        </a>
        <div className="text-[10px] text-[color:var(--color-text-secondary)]">
          {r.page_category || 'Page'}
          {r.page_id && <> · id {r.page_id}</>}
        </div>
      </td>

      <td className="px-3 py-2">
        {r.niche_score == null ? (
          <span
            className="cursor-help text-[11px] text-[color:var(--color-text-secondary)]"
            title="Not scored yet — click “Score & check” to compute an affiliate likelihood for each advertiser."
          >
            not scored
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {r.is_likely_affiliate ? (
              <span
                className="inline-flex cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
                title={`Likely casino affiliate. Niche score ${niche}/100 (≥30 is flagged). Built from casino ad landing links, gambling keywords in the ad copy, and a gambling-flavoured Page name — higher = stronger signal.`}
              >
                <CheckCircle2 className="h-3 w-3" /> affiliate · {niche}
              </span>
            ) : (
              <span
                className="cursor-help rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-secondary)]"
                title={`Not flagged as an affiliate. Niche score ${niche}/100 (below the 30 threshold).`}
              >
                no · {niche}
              </span>
            )}
            {r.is_new_lead_candidate && (
              <span
                className="inline-flex cursor-help items-center gap-1 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800"
                title="New lead candidate — a likely affiliate whose affiliate ID / Page name isn’t on Monday yet. Worth reviewing for outreach."
              >
                <Sparkles className="h-3 w-3" /> NEW
              </span>
            )}
          </div>
        )}
      </td>

      <td className="px-3 py-2">
        <MondayCell r={r} />
      </td>

      <td className="px-3 py-2">
        <ContactCell r={r} />
      </td>

      <td className="px-3 py-2 text-right tabular-nums text-[color:var(--color-text-primary)]">
        {adCount == null ? '—' : adCount.toLocaleString()}
      </td>

      <td className="px-3 py-2">
        {r.page_website_url ? (
          <SocialChip href={r.page_website_url} short="WWW" label="Website" icon />
        ) : (
          <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
        )}
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {r.links
            .filter(l => l.source !== 'page_website')
            .map((l, i) => (
              <LinkChip
                key={`l${i}`}
                href={l.resolved_url ?? l.url}
                label={l.brand || hostLabel(l.resolved_url ?? l.url)}
                isNew={l.is_known_on_monday === false}
              />
            ))}
          {r.links.filter(l => l.source !== 'page_website').length === 0 && (
            <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
          )}
        </div>
      </td>
    </tr>
  )
}

/** Monday recognition badge — three states:
 *   - is_known_on_monday === true  → green ✓ "On Monday" (with matched-links count)
 *   - is_known_on_monday === false → grey ✕ "Not on Monday"
 *   - is_known_on_monday === null  → dash (scoring hasn't run)
 *
 * When on Monday, the subtitle counts how many of the Page's ad links
 * resolved to a Monday item so operators can drill in via the last
 * column's blue chips.
 */
function MondayCell({ r }: { r: FbAdvertiserRow }) {
  if (r.is_known_on_monday === null || r.is_known_on_monday === undefined) {
    return (
      <span
        className="cursor-help text-[11px] text-[color:var(--color-text-secondary)]"
        title="Not scored yet — click “Score & check” to run the Monday match."
      >
        —
      </span>
    )
  }
  const matchedLinks = r.links.filter(l => l.is_known_on_monday === true).length
  const totalLinks = r.links.length
  if (r.is_known_on_monday === true) {
    return (
      <div className="flex flex-col gap-0.5">
        <span
          className="inline-flex w-fit cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
          title="This Page is already known on a Monday board — either the Page name / ID matched, or an ad link resolved to an S-tag on Monday. See the ad-links column (blue chips) for which URLs matched."
        >
          <CheckCircle2 className="h-3 w-3" /> On Monday
        </span>
        {totalLinks > 0 && (
          <span
            className="text-[10px] text-[color:var(--color-text-secondary)]"
            title={`${matchedLinks} of ${totalLinks} ad links matched a Monday item.`}
          >
            {matchedLinks}/{totalLinks} links
          </span>
        )}
      </div>
    )
  }
  return (
    <span
      className="inline-flex cursor-help items-center gap-1 rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-text-secondary)]"
      title="Not on Monday yet — the Page name, its affiliate IDs, and its ad links were all checked against the four Monday boards and none matched."
    >
      <XCircle className="h-3 w-3" /> Not on Monday
    </span>
  )
}

/** Outreach contacts mined from the ad copy: email › Telegram › Discord. */
function ContactCell({ r }: { r: FbAdvertiserRow }) {
  const hasAny = r.contact_email || r.telegram_url || r.discord_url
  if (!hasAny) return <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>

  return (
    <div className="flex flex-wrap items-center gap-1">
      {r.contact_email && (
        <ContactChip
          href={`mailto:${r.contact_email}`}
          label={r.contact_email}
          icon={<Mail className="h-2.5 w-2.5 shrink-0" />}
          className="bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
        />
      )}
      {r.telegram_url && (
        <ContactChip
          href={r.telegram_url}
          label="Telegram"
          external
          icon={<Send className="h-2.5 w-2.5 shrink-0" />}
          className="bg-sky-100 text-sky-800 hover:bg-sky-200"
        />
      )}
      {r.discord_url && (
        <ContactChip
          href={r.discord_url}
          label="Discord"
          external
          icon={<MessageCircle className="h-2.5 w-2.5 shrink-0" />}
          className="bg-indigo-100 text-indigo-800 hover:bg-indigo-200"
        />
      )}
    </div>
  )
}

function ContactChip({
  href,
  label,
  icon,
  className,
  external,
}: {
  href: string
  label: string
  icon: ReactNode
  className: string
  external?: boolean
}) {
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      title={external ? href : label}
      className={[
        'inline-flex max-w-[200px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        className,
      ].join(' ')}
    >
      {icon}
      <span className="truncate">{label}</span>
    </a>
  )
}

function SocialChip({
  href,
  short,
  label,
  icon,
}: {
  href: string | null
  short: string
  label: string
  icon?: boolean
}) {
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`${label} — ${href}`}
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded bg-[color:var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
    >
      {icon && <Globe className="h-2.5 w-2.5" />}
      {short}
    </a>
  )
}

function LinkChip({ href, label, isNew }: { href: string; label: string; isNew?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={isNew ? `${href} — not on Monday yet` : href}
      className={[
        'inline-flex max-w-[180px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        isNew
          ? 'bg-purple-100 text-purple-800 hover:bg-purple-200'
          : 'bg-blue-100 text-blue-800 hover:bg-blue-200',
      ].join(' ')}
    >
      {isNew ? <Sparkles className="h-2.5 w-2.5 shrink-0" /> : <ExternalLink className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </a>
  )
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
