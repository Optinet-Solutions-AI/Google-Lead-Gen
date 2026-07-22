'use client'

import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Circle, ExternalLink, Mail, MessageCircle, MonitorPlay, Send, Sparkles } from 'lucide-react'
import type { TwitchStreamerRow } from '../_lib/queries'
import { MondayStatusCell } from './monday-status-cell'

/**
 * Per-streamer results table for Twitch jobs (Phase 3). Default order: NEW
 * candidates first, then likely affiliates, then follower_count DESC as a
 * tie-break (bigger channels rise). Operators can override by clicking the
 * Followers column header — one click sorts high-to-low, another low-to-high,
 * a third returns to the default. Follower count is fetched via Twitch's
 * public web GraphQL (see fetch_channel_info in twitch_search.py, added
 * 2026-07-22). Contacts + last-active come from text mining.
 */

type SortMode = 'default' | 'followers_desc' | 'followers_asc'

export function TwitchStreamersTable({ rows }: { rows: TwitchStreamerRow[] }) {
  const [sortMode, setSortMode] = useState<SortMode>('default')

  const sortedRows = useMemo(() => {
    if (sortMode === 'default') return rows
    // NULLs go to the bottom regardless of asc/desc — we can't sort by an
    // unknown value meaningfully, so "unknown" is always last.
    const dir = sortMode === 'followers_desc' ? -1 : 1
    return rows.slice().sort((a, b) => {
      const av = a.follower_count
      const bv = b.follower_count
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir * (av - bv)
    })
  }, [rows, sortMode])

  const cycleSort = () => {
    setSortMode(m =>
      m === 'default' ? 'followers_desc' : m === 'followers_desc' ? 'followers_asc' : 'default',
    )
  }

  const SortIcon = sortMode === 'followers_desc' ? ArrowDown : sortMode === 'followers_asc' ? ArrowUp : ArrowUpDown

  if (rows.length === 0) return null

  return (
    <div className="rounded-lg border border-[color:var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-[color:var(--color-bg-secondary)]">
          <tr className="text-left text-[11px] text-[color:var(--color-text-secondary)] [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:border-b [&>th]:border-[color:var(--color-border)] [&>th]:bg-[color:var(--color-bg-secondary)]">
            <th className="px-3 py-2 font-medium">Streamer</th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Affiliate likelihood + niche score (0–100). “affiliate” = scored ≥30 (or links a casino directly in an About-panel). NEW = a likely affiliate whose affiliate ID / @login isn’t on Monday yet. Hover a badge for the breakdown."
            >
              Affiliate
            </th>
            <th
              className="cursor-help px-3 py-2 font-medium"
              title="Monday recognition. Green ✓ = the streamer / affiliate ID / any of their About-panel links is already on a Monday board. Grey ✕ = we checked and found no match. Blank = scoring hasn’t run yet."
            >
              On Monday
            </th>
            <th className="px-3 py-2 text-right font-medium">
              <button
                type="button"
                onClick={cycleSort}
                title={
                  sortMode === 'default'
                    ? 'Click to sort by follower count, highest first. Follower count is fetched via Twitch\'s public web GraphQL. — = unavailable (legacy row or GraphQL fetch failed).'
                    : sortMode === 'followers_desc'
                      ? 'Sorted by follower count, highest first. Click again for lowest first.'
                      : 'Sorted by follower count, lowest first. Click again to reset to default order.'
                }
                className={[
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[color:var(--color-bg-primary)]',
                  sortMode !== 'default' ? 'text-[color:var(--color-text-primary)]' : '',
                ].join(' ')}
              >
                Followers
                <SortIcon className="h-3 w-3" />
              </button>
            </th>
            <th className="px-3 py-2 font-medium">Game / language</th>
            <th className="px-3 py-2 font-medium">Contact</th>
            <th className="px-3 py-2 font-medium">Casino partners / links</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(r => (
            <TwitchStreamerRowView key={r.id} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TwitchStreamerRowView({ r }: { r: TwitchStreamerRow }) {
  const niche = r.niche_score == null ? null : Number(r.niche_score)

  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-0 align-top">
      <td className="px-3 py-2">
        <a
          href={r.broadcaster_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-[color:var(--color-text-primary)] hover:underline"
        >
          <MonitorPlay className="h-3 w-3 text-[#9146FF] shrink-0" />
          {r.display_name || r.broadcaster_login}
          {r.is_live && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-red-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-red-700"
              title="Live now"
            >
              <Circle className="h-2 w-2 fill-current" /> live
            </span>
          )}
        </a>
        <div className="text-[10px] text-[color:var(--color-text-secondary)]">@{r.broadcaster_login}</div>
        <LastActive
          iso={r.last_activity_at}
          label={r.last_active_label}
          stale={r.last_active_stale}
          isLive={r.is_live}
        />
      </td>

      <td className="px-3 py-2">
        {r.niche_score == null ? (
          <span
            className="cursor-help text-[11px] text-[color:var(--color-text-secondary)]"
            title="Not scored yet — click “Score & check” to compute an affiliate likelihood for each streamer."
          >
            not scored
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {r.is_likely_affiliate ? (
              <span
                className="inline-flex cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
                title={`Likely casino affiliate. Niche score ${niche}/100 (≥30 is flagged). Built from the casino links in the channel's About-panels/bio, gambling keywords in the bio/title, and a gambling game category — higher = stronger signal.`}
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
            {r.is_new_lead_candidate ? (
              <span
                className="inline-flex cursor-help items-center gap-1 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800"
                title="New lead candidate — a likely affiliate whose affiliate ID / @login isn’t on Monday yet. Worth reviewing for outreach."
              >
                <Sparkles className="h-3 w-3" /> NEW
              </span>
            ) : (
              r.is_known_on_monday === true && (
                <span
                  className="inline-flex cursor-help items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
                  title="Already on Monday — this affiliate’s ID / @login was matched against the board during “Score & check”."
                >
                  <CheckCircle2 className="h-3 w-3" /> on Monday
                </span>
              )
            )}
          </div>
        )}
      </td>

      <td className="px-3 py-2">
        <MondayStatusCell
          isKnownOnMonday={r.is_known_on_monday}
          links={r.links}
        />
      </td>

      <td className="px-3 py-2 text-right font-mono tabular-nums text-[11px] text-[color:var(--color-text-primary)]">
        {r.follower_count == null ? (
          <span className="text-[color:var(--color-text-secondary)]" title="Follower count not available — GraphQL fetch failed or row scraped before follower fetch was added.">—</span>
        ) : (
          r.follower_count.toLocaleString()
        )}
      </td>
      <td className="px-3 py-2 text-[11px] text-[color:var(--color-text-secondary)]">
        {r.game_name || '—'}
        {r.broadcaster_language && (
          <span className="ml-1 rounded bg-[color:var(--color-bg-secondary)] px-1 py-0.5 text-[10px] uppercase">
            {r.broadcaster_language}
          </span>
        )}
      </td>

      <td className="px-3 py-2">
        <ContactCell email={r.contact_email} telegram={r.telegram_url} discord={r.discord_url} />
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {(() => {
            const partners = partnerLinks(r.links)
            if (partners.length === 0)
              return <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
            return partners.map((p, i) => (
              <LinkChip
                key={`l${i}`}
                href={p.href}
                label={p.label}
                source={p.source}
                isNew={p.isNew}
                onMonday={p.onMonday}
                count={p.count}
              />
            ))
          })()}
        </div>
      </td>
    </tr>
  )
}

/** Relative "last active" line under the streamer name. Channels dormant for
 *  years are dropped before insert (see twitch_search.py recency gate), so a
 *  visible date here is recent-ish; NULL means activity couldn't be measured
 *  (e.g. VODs/clips disabled), shown as a soft "activity unknown". The label /
 *  stale flag are computed server-side in queries.ts (Date.now is impure in a
 *  component render). */
function LastActive({
  iso,
  label,
  stale,
  isLive,
}: {
  iso: string | null
  label: string | null
  stale: boolean
  isLive: boolean | null
}) {
  if (isLive) return null // the "live" badge by the name already says it
  if (!label) {
    return (
      <div
        className="cursor-help text-[10px] text-[color:var(--color-text-secondary)] italic"
        title="No VOD, clip, or live signal to date the channel's last activity (VOD storage may be off). Kept rather than dropped by the recency gate."
      >
        activity unknown
      </div>
    )
  }
  return (
    <div
      className={['text-[10px]', stale ? 'text-amber-600' : 'text-[color:var(--color-text-secondary)]'].join(' ')}
      title={iso ? `Last activity (newest VOD/clip or live session): ${new Date(iso).toLocaleDateString()}` : undefined}
    >
      {label}
    </div>
  )
}

/** Email / Telegram / Discord mined from the bio + About-panels (the contact
 *  info Andrei flagged as being missed). Renders click-through chips. */
function ContactCell({
  email,
  telegram,
  discord,
}: {
  email: string | null
  telegram: string | null
  discord: string | null
}) {
  if (!email && !telegram && !discord)
    return <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
  return (
    <div className="flex flex-col gap-0.5">
      {email && (
        <a
          href={`mailto:${email}`}
          title={email}
          className="inline-flex max-w-[180px] items-center gap-1 truncate text-[11px] text-blue-700 hover:underline"
        >
          <Mail className="h-3 w-3 shrink-0" />
          <span className="truncate">{email}</span>
        </a>
      )}
      {telegram && (
        <a
          href={telegram}
          target="_blank"
          rel="noreferrer"
          title={telegram}
          className="inline-flex max-w-[180px] items-center gap-1 truncate text-[11px] text-sky-700 hover:underline"
        >
          <Send className="h-3 w-3 shrink-0" />
          <span className="truncate">{telegram.replace(/^https?:\/\//, '')}</span>
        </a>
      )}
      {discord && (
        <a
          href={discord}
          target="_blank"
          rel="noreferrer"
          title={discord}
          className="inline-flex max-w-[180px] items-center gap-1 truncate text-[11px] text-indigo-700 hover:underline"
        >
          <MessageCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">{discord.replace(/^https?:\/\//, '')}</span>
        </a>
      )}
    </div>
  )
}

function LinkChip({
  href,
  label,
  source,
  isNew,
  onMonday,
  count,
}: {
  href: string
  label: string
  source: string
  isNew?: boolean
  onMonday?: boolean
  count?: number
}) {
  // Three states: NEW (not on Monday — actionable) takes priority, then
  // already-on-Monday (known), else a neutral captured link.
  const status = isNew ? 'new' : onMonday ? 'monday' : 'neutral'
  const cls =
    status === 'new'
      ? 'bg-purple-100 text-purple-800 hover:bg-purple-200'
      : status === 'monday'
        ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
        : 'bg-blue-100 text-blue-800 hover:bg-blue-200'
  const note = status === 'new' ? ' — not on Monday yet' : status === 'monday' ? ' — already on Monday' : ''
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`${source}${count && count > 1 ? ` (${count} links to this host)` : ''}${note}: ${href}`}
      className={[
        'inline-flex max-w-[180px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        cls,
      ].join(' ')}
    >
      {status === 'new' ? (
        <Sparkles className="h-2.5 w-2.5 shrink-0" />
      ) : status === 'monday' ? (
        <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
      ) : (
        <ExternalLink className="h-2.5 w-2.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
      {count && count > 1 ? <span className="shrink-0 opacity-60">×{count}</span> : null}
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

// Hosts that are never affiliate "partners" — socials, donation/streaming
// platforms, music, and responsible-gambling regulators. Dropped from the
// partners column so the casino funnel links aren't buried in noise. (They're
// still in twitch_links for the record; scoring already ignores them.)
const NON_PARTNER_HOSTS = new Set([
  'youtube.com', 'youtu.be', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'tiktok.com', 'soundcloud.com', 'spotify.com', 'twitch.tv', 'reddit.com',
  'streamlabs.com', 'streamelements.com', 'tipeeestream.com', 'ko-fi.com', 'patreon.com',
  'begambleaware.org', 'gambleaware.org', 'gambleaware.co.uk', 'gamcare.org.uk', 'gamstop.co.uk',
])

function isNonPartnerHost(host: string): boolean {
  if (!host) return true
  for (const h of NON_PARTNER_HOSTS) {
    if (host === h || host.endsWith('.' + h)) return true
  }
  return false
}

type PartnerChip = { href: string; label: string; source: string; isNew: boolean; onMonday: boolean; count: number }

/** Filter a streamer's links to actual casino-partner links and collapse
 *  duplicates by host (so `youtube.com ×30` / `twitch.tv ×9` noise is gone and
 *  one chip per host remains). For each host, keep the most informative link —
 *  prefer a brand'd or NEW (not-on-Monday) one. */
function partnerLinks(links: TwitchStreamerRow['links']): PartnerChip[] {
  const byHost = new Map<string, PartnerChip>()
  for (const l of links) {
    const dest = l.resolved_url ?? l.url
    const host = hostLabel(dest)
    if (isNonPartnerHost(host)) continue
    const isNew = l.is_known_on_monday === false
    const onMonday = l.is_known_on_monday === true
    const existing = byHost.get(host)
    if (!existing) {
      byHost.set(host, { href: dest, label: l.brand || host, source: l.source, isNew, onMonday, count: 1 })
      continue
    }
    existing.count++
    // Upgrade the kept chip if this one carries a brand, a NEW flag, or an
    // on-Monday match.
    if (l.brand && existing.label === host) existing.label = l.brand
    if (isNew) existing.isNew = true
    if (onMonday) existing.onMonday = true
  }
  // Brand'd / NEW partners first, then alphabetical for a stable order.
  return [...byHost.values()].sort((a, b) => {
    const aw = (a.isNew ? 2 : 0) + (a.label !== hostLabel(a.href) ? 1 : 0)
    const bw = (b.isNew ? 2 : 0) + (b.label !== hostLabel(b.href) ? 1 : 0)
    if (aw !== bw) return bw - aw
    return a.label.localeCompare(b.label)
  })
}
