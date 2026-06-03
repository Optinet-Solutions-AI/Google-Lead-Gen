import type { ReactNode } from 'react'
import { BadgeCheck, CheckCircle2, ExternalLink, Globe, Mail, MessageCircle, Send, Sparkles } from 'lucide-react'
import type { XCreatorRow } from '../_lib/queries'

/**
 * Per-creator results table for X jobs (Phase 3). New lead candidates first,
 * then affiliates, showing the niche score + NEW badge, follower count,
 * contacts (Telegram › Discord; X exposes no email), socials, and the
 * bio/pinned/website affiliate links that drove the flag. Server component.
 *
 * Sibling of kick-streamers-table.tsx / youtube-channels-table.tsx. Profile
 * links render as x.com, never twitter.com (repo convention, commit 4649a7f).
 */
export function XCreatorsTable({ rows }: { rows: XCreatorRow[] }) {
  if (rows.length === 0) return null

  return (
    <div className="rounded-lg border border-[color:var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-[color:var(--color-bg-secondary)]">
          <tr className="text-left text-[11px] text-[color:var(--color-text-secondary)] [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:border-b [&>th]:border-[color:var(--color-border)] [&>th]:bg-[color:var(--color-bg-secondary)]">
            <th className="px-3 py-2 font-medium">Creator</th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Affiliate likelihood + niche score (0–100). “affiliate” = scored ≥30 (or links a casino directly). NEW = a likely affiliate whose affiliate ID / @handle isn’t on Monday yet. Hover a badge for the breakdown."
            >
              Affiliate
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Outreach contacts mined from the bio + pinned tweet — priority Telegram › Discord (X exposes no email). Run “Score & check” to populate."
            >
              Contact
            </th>
            <th className="px-3 py-2 font-medium text-right">Followers</th>
            <th className="px-3 py-2 font-medium">Socials</th>
            <th className="px-3 py-2 font-medium">Casino partners / links</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <XCreatorRowView key={r.id} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function XCreatorRowView({ r }: { r: XCreatorRow }) {
  const niche = r.niche_score == null ? null : Number(r.niche_score)

  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-0 align-top">
      <td className="px-3 py-2">
        <a
          href={r.profile_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-[color:var(--color-text-primary)] hover:underline"
        >
          {r.display_name || `@${r.username}`}
          {r.verified && <BadgeCheck className="h-3 w-3 text-sky-500" aria-label="Verified" />}
        </a>
        <div className="text-[10px] text-[color:var(--color-text-secondary)]">
          @{r.username}
          {r.location && <> · {r.location}</>}
        </div>
      </td>

      <td className="px-3 py-2">
        {r.niche_score == null ? (
          <span
            className="cursor-help text-[11px] text-[color:var(--color-text-secondary)]"
            title="Not scored yet — click “Score & check” to compute an affiliate likelihood for each creator."
          >
            not scored
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {r.is_likely_affiliate ? (
              <span
                className="inline-flex cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
                title={`Likely casino affiliate. Niche score ${niche}/100 (≥30 is flagged). Built from casino affiliate links (bio / pinned / website), gambling keywords, and a gambling-flavoured name — higher = stronger signal.`}
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
                title="New lead candidate — a likely affiliate whose affiliate ID / @handle isn’t on Monday yet. Worth reviewing for outreach."
              >
                <Sparkles className="h-3 w-3" /> NEW
              </span>
            )}
          </div>
        )}
      </td>

      <td className="px-3 py-2">
        <ContactCell r={r} />
      </td>

      <td className="px-3 py-2 text-right tabular-nums text-[color:var(--color-text-primary)]">
        {r.followers_count == null ? '—' : r.followers_count.toLocaleString()}
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <SocialChip href={r.website_url} short="WWW" label="Website" icon />
          <SocialChip href={r.instagram_handle} short="IG" label="Instagram" />
          <SocialChip href={r.youtube_handle} short="YT" label="YouTube" />
          <SocialChip href={r.tiktok_handle} short="TT" label="TikTok" />
          <SocialChip href={r.facebook_handle} short="FB" label="Facebook" />
          {!r.website_url &&
            !r.instagram_handle &&
            !r.youtube_handle &&
            !r.tiktok_handle &&
            !r.facebook_handle && (
              <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
            )}
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {r.links.map((l, i) => (
            <LinkChip
              key={`l${i}`}
              href={l.resolved_url ?? l.url}
              label={l.brand || hostLabel(l.resolved_url ?? l.url)}
              isNew={l.is_known_on_monday === false}
            />
          ))}
          {r.links.length === 0 && (
            <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
          )}
        </div>
      </td>
    </tr>
  )
}

/** Outreach contacts: Telegram › Discord (X exposes no email vector, but the
 *  bio/pinned occasionally carries a mailto, so render it first if present). */
function ContactCell({ r }: { r: XCreatorRow }) {
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
