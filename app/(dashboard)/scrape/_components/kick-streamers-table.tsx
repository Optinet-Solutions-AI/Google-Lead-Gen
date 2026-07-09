import type { ReactNode } from 'react'
import { CheckCircle2, ExternalLink, Mail, MessageCircle, Pin, Send } from 'lucide-react'
import type { KickStreamerRow } from '../_lib/queries'
import { MondayStatusCell } from './monday-status-cell'

/**
 * Per-streamer results table for Kick jobs (Phase 3). Affiliates first,
 * showing the niche score, follower count, social handles, and the casino
 * promo / pinned-chat links that drove the affiliate flag. Server component
 * — pure render, no interactivity.
 */
export function KickStreamersTable({ rows }: { rows: KickStreamerRow[] }) {
  if (rows.length === 0) return null

  // No inner overflow wrapper: per-cell sticky <th> pins the header to the
  // viewport as the PAGE scrolls — matches the jobs table (jobs-table.tsx).
  // An overflow wrapper would trap the sticky cells inside it.
  return (
    <div className="rounded-lg border border-[color:var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-[color:var(--color-bg-secondary)]">
          <tr className="text-left text-[11px] text-[color:var(--color-text-secondary)] [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:border-b [&>th]:border-[color:var(--color-border)] [&>th]:bg-[color:var(--color-bg-secondary)]">
            <th className="px-3 py-2 font-medium">Streamer</th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Broadcast language of the channel, as reported by Kick for the discovered stream."
            >
              Language
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Affiliate likelihood + niche score (0–100). “affiliate” = scored ≥30 (likely a casino affiliate); “no” = below 30. Hover a badge for the breakdown."
            >
              Affiliate
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Monday recognition. Green ✓ = the streamer’s channel slug / affiliate ID / any of its casino links is already on a Monday board. Grey ✕ = we checked and found no match. Blank = scoring hasn’t run yet."
            >
              On Monday
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Outreach contacts mined from the bio, pinned chat, and promo cards — priority order email › Telegram › Discord. Run “Score & resolve” to populate."
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
            <KickStreamerRowView key={r.id} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function KickStreamerRowView({ r }: { r: KickStreamerRow }) {
  const niche = r.niche_score == null ? null : Number(r.niche_score)
  const promo = r.links.filter(l => l.source === 'promo_card')
  const pinned = r.links.filter(l => l.source === 'pinned_chat')

  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-0 align-top">
      <td className="px-3 py-2">
        <a
          href={r.channel_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-[color:var(--color-text-primary)] hover:underline"
        >
          {r.slug}
          {r.is_live && <span className="h-1.5 w-1.5 rounded-full bg-red-500" title="Live now" />}
        </a>
        {r.category_name && (
          <div className="text-[10px] text-[color:var(--color-text-secondary)]">{r.category_name}</div>
        )}
      </td>

      <td className="px-3 py-2 text-[color:var(--color-text-primary)]">
        {r.stream_language ? (
          languageLabel(r.stream_language)
        ) : (
          <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
        )}
      </td>

      <td className="px-3 py-2">
        {r.niche_score == null ? (
          <span
            className="cursor-help text-[11px] text-[color:var(--color-text-secondary)]"
            title="Not scored yet — click “Score & resolve” to compute an affiliate likelihood for each streamer."
          >
            not scored
          </span>
        ) : r.is_likely_affiliate ? (
          <span
            className="inline-flex cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
            title={`Likely casino affiliate. Niche score ${niche}/100 (≥30 is flagged). Built from casino promo cards, affiliate-ref links (?r=, /r/, ?c=), gambling tags, and casino keywords — higher = stronger signal.`}
          >
            <CheckCircle2 className="h-3 w-3" /> affiliate · {niche}
          </span>
        ) : (
          <span
            className="cursor-help rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-secondary)]"
            title={`Not flagged as an affiliate. Niche score ${niche}/100 (below the 30 threshold). Same signals as affiliates — casino promo cards, affiliate-ref links, gambling tags/keywords — just weaker.`}
          >
            no · {niche}
          </span>
        )}
      </td>

      <td className="px-3 py-2">
        <MondayStatusCell isKnownOnMonday={r.is_known_on_monday} links={r.links} />
      </td>

      <td className="px-3 py-2">
        <ContactCell r={r} />
      </td>

      <td className="px-3 py-2 text-right tabular-nums text-[color:var(--color-text-primary)]">
        {r.follower_count == null ? '—' : r.follower_count.toLocaleString()}
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <SocialChip href={r.instagram_handle} short="IG" label="Instagram" />
          <SocialChip href={r.youtube_handle} short="YT" label="YouTube" />
          <SocialChip href={r.twitter_handle} short="X" label="Twitter / X" />
          <SocialChip href={r.tiktok_handle} short="TT" label="TikTok" />
          <SocialChip href={r.facebook_handle} short="FB" label="Facebook" />
          {!r.instagram_handle &&
            !r.youtube_handle &&
            !r.twitter_handle &&
            !r.tiktok_handle &&
            !r.facebook_handle && (
              <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
            )}
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {promo.map((l, i) => (
            <LinkChip
              key={`p${i}`}
              href={l.resolved_url ?? l.url}
              label={l.promo_brand || hostLabel(l.resolved_url ?? l.url)}
            />
          ))}
          {pinned.map((l, i) => (
            <LinkChip key={`c${i}`} href={l.resolved_url ?? l.url} label={hostLabel(l.resolved_url ?? l.url)} pinned />
          ))}
          {promo.length === 0 && pinned.length === 0 && (
            <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
          )}
        </div>
      </td>
    </tr>
  )
}

/**
 * Outreach contacts, in the playbook's priority order: email › Telegram ›
 * Discord. Email is a mailto: link; the others open in a new tab. Socials
 * stay in their own column — these three are the high-value channels.
 */
function ContactCell({ r }: { r: KickStreamerRow }) {
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
}: {
  href: string | null
  short: string
  label: string
}) {
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`${label} — ${href}`}
      aria-label={label}
      className="inline-flex items-center rounded bg-[color:var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
    >
      {short}
    </a>
  )
}

function LinkChip({ href, label, pinned }: { href: string; label: string; pinned?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      className={[
        'inline-flex max-w-[180px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        pinned
          ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
          : 'bg-blue-100 text-blue-800 hover:bg-blue-200',
      ].join(' ')}
    >
      {pinned ? <Pin className="h-2.5 w-2.5 shrink-0" /> : <ExternalLink className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </a>
  )
}

// Kick reports the stream language as either a full English name
// ("English", "português") or an ISO-639-1 code ("en", "pt") depending on
// the endpoint version. Map the common codes; otherwise just capitalize
// whatever Kick gave us so the cell reads cleanly either way.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  ru: 'Russian',
  ar: 'Arabic',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  cs: 'Czech',
  el: 'Greek',
  ro: 'Romanian',
  hu: 'Hungarian',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  tl: 'Filipino',
}

function languageLabel(raw: string): string {
  const v = raw.trim()
  const mapped = LANGUAGE_NAMES[v.toLowerCase()]
  if (mapped) return mapped
  return v.charAt(0).toUpperCase() + v.slice(1)
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
