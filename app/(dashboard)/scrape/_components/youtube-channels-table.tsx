'use client'

import { useState, type ReactNode } from 'react'
import { CheckCircle2, ExternalLink, Eye, Filter, Globe, Mail, MessageCircle, Send, ShieldAlert, Sparkles } from 'lucide-react'
import type { YoutubeChannelRow } from '../_lib/queries'

/**
 * Per-channel results table for YouTube jobs (Phase 3). New-lead candidates
 * first, showing the niche score, subscribers, contacts, socials, and the
 * affiliate S-tags mined from video descriptions (with a new/known badge per
 * tag). Mirrors KickStreamersTable / TiktokCreatorsTable.
 *
 * Relevance filter (Darren 2026-06-09): YouTube pokie/slot-keyword scrapes
 * surface ~90% irrelevant channels — gameplay vloggers, land-based-casino
 * vlogs, even a news program. By default the table shows only the relevant
 * rows: once scoring has run, the likely affiliates (a casino funnel link is
 * the only actionable tell on YouTube), hiding both the no-funnel non-affiliates
 * (is_not_relevant) and scored non-affiliates. A "Show all" toggle reveals the
 * full discovery set. Client component for the toggle.
 */
export function YoutubeChannelsTable({ rows }: { rows: YoutubeChannelRow[] }) {
  const [showAll, setShowAll] = useState(false)
  if (rows.length === 0) return null

  const anyScored = rows.some(r => r.niche_score != null)
  // Default ("relevant only"): drop the no-funnel non-affiliates, and — once
  // scoring has run — keep only the likely affiliates. Before scoring there are
  // no affiliate flags yet, so we keep everything (the discovery set can't be
  // relevance-judged until "Score & check" runs).
  const relevant = rows.filter(r => {
    if (r.is_not_relevant) return false
    if (anyScored) return r.is_likely_affiliate === true
    return true
  })
  const visible = showAll ? rows : relevant
  const hidden = rows.length - relevant.length

  return (
    <div className="space-y-2">
      {hidden > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[color:var(--color-text-secondary)]">
          <span>
            Showing <span className="font-medium text-[color:var(--color-text-primary)]">{visible.length}</span> of{' '}
            {rows.length} discovered ·{' '}
            {showAll
              ? `${hidden} hidden in the relevant view (no-funnel gameplay / land-based / non-affiliates)`
              : `${hidden} hidden (no-funnel gameplay / land-based${anyScored ? ' / non-affiliates' : ''})`}
          </span>
          <button
            type="button"
            onClick={() => setShowAll(v => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            {showAll ? (
              <>
                <Filter className="h-3 w-3" /> Relevant only
              </>
            ) : (
              <>
                <Eye className="h-3 w-3" /> Show all {rows.length}
              </>
            )}
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-4 text-[12px] text-[color:var(--color-text-secondary)]">
          {anyScored ? (
            <>No likely affiliates among the {rows.length} discovered channel{rows.length === 1 ? '' : 's'} — YouTube pokie/slot-keyword scrapes mostly surface gameplay vloggers &amp; land-based-casino channels with no casino funnel link. Use <strong>Show all</strong> above to review the full set.</>
          ) : (
            <>The {rows.length} discovered channel{rows.length === 1 ? '' : 's'} {rows.length === 1 ? 'is' : 'are'} not scored yet — run <strong>Enrich contacts</strong> then <strong>Score &amp; check</strong> to flag affiliates. Use <strong>Show all</strong> to review them now.</>
          )}
        </div>
      ) : (
        <YoutubeTable rows={visible} />
      )}
    </div>
  )
}

function YoutubeTable({ rows }: { rows: YoutubeChannelRow[] }) {
  return (
    <div className="rounded-lg border border-[color:var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-[color:var(--color-bg-secondary)]">
          <tr className="text-left text-[11px] text-[color:var(--color-text-secondary)] [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:border-b [&>th]:border-[color:var(--color-border)] [&>th]:bg-[color:var(--color-bg-secondary)]">
            <th className="px-3 py-2 font-medium">Channel</th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Affiliate likelihood + niche score (0–100). “affiliate” = scored ≥30 or carrying a casino affiliate link. A NEW badge means a likely affiliate whose channel isn’t on Monday yet."
            >
              Affiliate
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Outreach contacts — priority order email › Telegram › Discord. Email comes from the About tab (Phase 2); Telegram/Discord may also be mined from descriptions (Phase 3)."
            >
              Contact
            </th>
            <th className="px-3 py-2 font-medium text-right">Subscribers</th>
            <th className="px-3 py-2 font-medium">Socials</th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Casino operators / affiliate links this channel promotes (from its video descriptions + landing page), checked against the company database. NEW = operator not found on Monday. (The classic stag/btag value sits behind a redirector — that's the 'stag later' follow-up.)"
            >
              Affiliate links
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <YoutubeChannelRowView key={r.id} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function YoutubeChannelRowView({ r }: { r: YoutubeChannelRow }) {
  const niche = r.niche_score == null ? null : Number(r.niche_score)
  const name = r.channel_name || r.channel_handle || r.channel_url

  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-0 align-top">
      <td className="px-3 py-2">
        <a
          href={r.channel_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-[color:var(--color-text-primary)] hover:underline"
        >
          {name}
        </a>
        {r.channel_handle && r.channel_handle !== name && (
          <div className="text-[10px] text-[color:var(--color-text-secondary)]">{r.channel_handle}</div>
        )}
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {r.niche_score == null ? (
            <span
              className="cursor-help text-[11px] text-[color:var(--color-text-secondary)]"
              title="Not scored yet — click “Score & check” to compute an affiliate likelihood for each channel."
            >
              not scored
            </span>
          ) : r.is_likely_affiliate ? (
            <span
              className="inline-flex cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
              title={`Likely casino affiliate. Niche score ${niche}/100 (≥30 is flagged). Built from casino affiliate links + gambling keywords in the channel and recent video descriptions.`}
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
              className="inline-flex cursor-help items-center gap-1 rounded-full bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-800"
              title="New lead candidate — a likely affiliate whose YouTube channel isn’t on Monday yet (matched by @handle). Review and add to outreach."
            >
              <Sparkles className="h-3 w-3" /> NEW
            </span>
          )}
        </div>
      </td>

      <td className="px-3 py-2">
        <ContactCell r={r} />
      </td>

      <td className="px-3 py-2 text-right tabular-nums text-[color:var(--color-text-primary)]">
        {r.subscriber_count == null ? '—' : r.subscriber_count.toLocaleString()}
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <SocialChip href={r.website_url} short="WWW" label="Website" />
          <SocialChip href={r.instagram_url} short="IG" label="Instagram" />
          <SocialChip href={r.twitter_url} short="X" label="Twitter / X" />
          <SocialChip href={r.tiktok_url} short="TT" label="TikTok" />
          {!r.website_url && !r.instagram_url && !r.twitter_url && !r.tiktok_url && (
            <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
          )}
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {r.links.map((l, i) => (
            <TagChip
              key={`t${i}`}
              label={[l.brand, l.s_tag].filter(Boolean).join(' · ') || l.s_tag || hostLabel(l.resolved_url ?? '')}
              href={l.resolved_url}
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

/** email › Telegram › Discord, mirroring the Kick contact cell. */
function ContactCell({ r }: { r: YoutubeChannelRow }) {
  const hasAny = r.email || r.telegram_url || r.discord_url
  if (!hasAny) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
        {r.about_tab_captcha_blocked && (
          <ShieldAlert className="h-3 w-3 text-amber-500" />
        )}
        {r.about_tab_captcha_blocked ? 'captcha-blocked' : '—'}
      </span>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {r.email && (
        <ContactChip
          href={`mailto:${r.email}`}
          label={r.email}
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

/** twitter.com is now x.com — rewrite the host so links and tooltips show the current domain. */
function normalizeTwitterUrl(href: string): string {
  return href.replace(/^(https?:\/\/(?:www\.)?)twitter\.com(?=[/?#]|$)/i, '$1x.com')
}

function SocialChip({
  href,
  short,
  label,
}: {
  href: string | null
  short: string
  label: string
}) {
  if (!href) return null
  const url = normalizeTwitterUrl(href)
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`${label} — ${url}`}
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded bg-[color:var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
    >
      {short === 'WWW' && <Globe className="h-2.5 w-2.5" />}
      {short}
    </a>
  )
}

function TagChip({ label, href, isNew }: { label: string; href: string | null; isNew: boolean }) {
  const cls = [
    'inline-flex max-w-[200px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium',
    isNew ? 'bg-fuchsia-100 text-fuchsia-800 hover:bg-fuchsia-200' : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  ].join(' ')
  const inner = (
    <>
      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{label}</span>
      {isNew && <span className="shrink-0 font-semibold">· new</span>}
    </>
  )
  if (!href) return <span className={cls} title={isNew ? 'Not found on Monday' : 'Already on Monday'}>{inner}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" title={`${href}${isNew ? ' — not on Monday' : ' — already on Monday'}`} className={cls}>
      {inner}
    </a>
  )
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url || '—'
  }
}
