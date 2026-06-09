'use client'

import { useState, type ReactNode } from 'react'
import { BadgeCheck, CheckCircle2, ExternalLink, Eye, Filter, Mail, MessageCircle, Send, Sparkles } from 'lucide-react'
import type { TiktokCreatorRow } from '../_lib/queries'

/**
 * Per-creator results table for TikTok jobs (Phase 3). New lead candidates
 * first, then affiliates, showing the niche score + NEW badge, follower count,
 * contacts (email › Telegram › Discord, mined from the bio + captions), and the
 * bio-link / caption affiliate links that drove the flag.
 *
 * Relevance filter (Andrei 2026-06-09): TikTok keyword scrapes surface a lot of
 * name-squatters (accounts named "casino" that post nothing casino-related). By
 * default the table shows only the relevant rows — the likely affiliates once
 * scoring has run, hiding both the Phase-2 no-funnel rejects (is_not_relevant)
 * and scored non-affiliates. A "Show all" toggle reveals the full discovery set.
 *
 * Sibling of x-creators-table.tsx — TikTok has no per-platform social columns
 * (the funnel is the single bio link), so the Socials column is dropped. Client
 * component for the filter toggle.
 */
export function TiktokCreatorsTable({ rows }: { rows: TiktokCreatorRow[] }) {
  const [showAll, setShowAll] = useState(false)
  if (rows.length === 0) return null

  const anyScored = rows.some(r => r.niche_score != null)
  // Default ("relevant only"): drop the Phase-2 no-funnel rejects, and — once
  // scoring has run — keep only the likely affiliates. Before scoring there are
  // no affiliate flags yet, so we keep everything that passed the Phase-2 gate.
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
              ? `${hidden} hidden in the relevant view (no-funnel name-squatters / non-affiliates)`
              : `${hidden} hidden (no-funnel name-squatters${anyScored ? ' / non-affiliates' : ''})`}
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
            <>No likely affiliates among the {rows.length} discovered creator{rows.length === 1 ? '' : 's'} — TikTok keyword scrapes mostly surface accounts merely <em>named</em> &ldquo;casino&rdquo;. Use <strong>Show all</strong> above to review the full set.</>
          ) : (
            <>The {rows.length} discovered creator{rows.length === 1 ? '' : 's'} {rows.length === 1 ? 'is' : 'are'} not scored yet — run <strong>Enrich profiles</strong> then <strong>Score &amp; check</strong> to flag affiliates. Use <strong>Show all</strong> to review them now.</>
          )}
        </div>
      ) : (
        <TiktokTable rows={visible} />
      )}
    </div>
  )
}

function TiktokTable({ rows }: { rows: TiktokCreatorRow[] }) {
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
              title="Outreach contacts mined from the bio + recent captions — priority email › Telegram › Discord. Run “Score & check” to populate."
            >
              Contact
            </th>
            <th className="px-3 py-2 font-medium text-right">Followers</th>
            <th className="px-3 py-2 font-medium">Casino partners / bio link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <TiktokCreatorRowView key={r.id} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TiktokCreatorRowView({ r }: { r: TiktokCreatorRow }) {
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
        <div className="text-[10px] text-[color:var(--color-text-secondary)]">@{r.username}</div>
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
                title={`Likely casino affiliate. Niche score ${niche}/100 (≥30 is flagged). Built from the bio link (hub / shortener / casino), gambling keywords in the bio + captions, and a gambling-flavoured name — higher = stronger signal.`}
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
        {r.follower_count == null ? '—' : r.follower_count.toLocaleString()}
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

/** Outreach contacts: email › Telegram › Discord, mined from the bio + captions. */
function ContactCell({ r }: { r: TiktokCreatorRow }) {
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
