import { CheckCircle2, Circle, ExternalLink, MonitorPlay, Sparkles } from 'lucide-react'
import type { TwitchStreamerRow } from '../_lib/queries'

/**
 * Per-streamer results table for Twitch jobs (Phase 3). New lead candidates
 * first, then affiliates, showing the niche score + NEW badge, the streamer's
 * game/language, and the casino links captured from their About-panels / bio /
 * VOD descriptions (the affiliate funnel). Server component.
 *
 * Sibling of telegram-channels-table.tsx. No contact or follower columns —
 * Twitch's app API exposes neither parseably (see twitch_search.py).
 */
export function TwitchStreamersTable({ rows }: { rows: TwitchStreamerRow[] }) {
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
            <th className="px-3 py-2 font-medium">Game / language</th>
            <th className="px-3 py-2 font-medium">Casino partners / links</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
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
            {r.is_new_lead_candidate && (
              <span
                className="inline-flex cursor-help items-center gap-1 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800"
                title="New lead candidate — a likely affiliate whose affiliate ID / @login isn’t on Monday yet. Worth reviewing for outreach."
              >
                <Sparkles className="h-3 w-3" /> NEW
              </span>
            )}
          </div>
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
        <div className="flex flex-wrap gap-1">
          {r.links.map((l, i) => (
            <LinkChip
              key={`l${i}`}
              href={l.resolved_url ?? l.url}
              label={l.brand || hostLabel(l.resolved_url ?? l.url)}
              source={l.source}
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

function LinkChip({
  href,
  label,
  source,
  isNew,
}: {
  href: string
  label: string
  source: string
  isNew?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`${source}${isNew ? ' — not on Monday yet' : ''}: ${href}`}
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
