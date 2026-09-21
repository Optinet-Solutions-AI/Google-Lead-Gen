'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Brain,
  Check,
  CheckCircle2,
  Copy,
  EyeOff,
  ExternalLink,
  FileText,
  Globe,
  Link2,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RotateCcw,
  Send,
  Tag,
  Trash2,
  User,
  Zap,
} from 'lucide-react'
import type { LeadDetail, ContactItemDetail, MondayCandidate } from '../../leads/_lib/detail-query'
import { invalidateLeadDetailCache } from '../../leads/_lib/detail-cache'
import {
  confirmMondayCandidate,
  deleteLeadScreenshot,
  forceEnrichLeadsAction,
  pushLeadToMondayAction,
  pushLeadToMondayNotRelevantAction,
  type PushNotRelevantState,
  type PushToMondayState,
} from '../../leads/actions'
import { setWebsiteNotRelevantAction, type WebsiteActionState } from '../actions'
import { MAX_OPERATOR_NOTE_LEN } from '@/lib/monday/push-constants'

type Detail = LeadDetail

function cleanDomain(raw: string | null): string {
  if (!raw) return '—'
  try {
    const u = raw.startsWith('http') ? new URL(raw) : new URL('http://' + raw)
    return u.hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .toLowerCase()
  }
}

/**
 * The operator actions, as a toolbar rather than a stack.
 *
 * On the old drawer these sat at the top as three panels of explanatory
 * prose, so you read three paragraphs about what the buttons do before
 * learning anything about the website. Each one is now a button that
 * expands only when you mean to use it.
 */
export function WebsiteActions({
  detail,
  leadIds,
  domain,
}: {
  detail: Detail
  /** Every appearance of this website, so the operator actions act on the
   *  site rather than on whichever row we happened to render. */
  leadIds: number[]
  domain: string
}) {
  const lead = detail.lead
  if (!lead) return null
  return (
    <div className="flex flex-wrap items-start gap-2 text-[12px]">
      <NotRelevantPanel
        leadId={lead.id}
        leadIds={leadIds}
        domain={domain}
        isNotRelevant={lead.is_not_relevant}
        markedAt={lead.not_relevant_marked_at}
        markedBy={lead.not_relevant_marked_by}
      />

      {!lead.is_not_relevant && lead.monday_board !== 'not_relevant_leads' && (
        <PushNotRelevantButton leadId={lead.id} />
      )}

      <PushToMondayPanel
        leadId={lead.id}
        pushedAt={lead.pushed_to_monday_at}
        pushedItemId={lead.monday_pushed_item_id}
        pushedBy={lead.monday_pushed_by}
      />
    </div>
  )
}

/**
 * The evidence, as cards that flow across the full width.
 *
 * Sections with nothing in them are left out entirely — a column of "—"
 * told you nothing and pushed the real content off the screen.
 */
export function WebsiteFacts({ detail }: { detail: Detail }) {
  const lead = detail.lead
  if (!lead) {
    return (
      <div className="text-[12px] text-[color:var(--color-text-secondary)]">
        No enrichment has run for this website yet.
      </div>
    )
  }

  const showAffiliate = lead.is_affiliate !== null || lead.affiliate_score != null
  const showRooster =
    lead.is_rooster_partner !== null || (lead.rooster_brands?.length ?? 0) > 0
  const showContacts = Boolean(detail.contact)
  const showStags = detail.stags.length > 0
  const showCohort = detail.cohort.length > 0

  return (
    <div className="columns-1 gap-4 text-[12px] lg:columns-2 2xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
      {lead.inherited_from_lead_id !== null && (
        <MemoryPanel
          leadId={lead.id}
          inheritedFromLeadId={lead.inherited_from_lead_id}
          inheritedAt={lead.inherited_at}
          isOnMonday={lead.is_on_monday === true}
          mondayBoard={lead.monday_board}
          isNotRelevant={lead.is_not_relevant}
          forceEnrich={lead.force_enrich}
        />
      )}

      {/* Which appearance the enrichment below actually ran against —
          contacts and s-tags are stored per lead row, so saying so keeps
          the page honest when a later re-sighting inherited the flags. */}
      <Section title="Enriched from this appearance">
        <KV label="Keyword" value={lead.keyword ?? '—'} />
        <KV label="Country" value={[lead.country, lead.country_code].filter(Boolean).join(' · ') || '—'} />
        <KV
          label="Type"
          value={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span>{lead.result_type ?? '—'}</span>
              {lead.seen_on === 'mobile' && (
                <span
                  className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800"
                  title="Mobile-only: this URL only appeared when the SERP was loaded with an iPhone UA + 375x812 viewport."
                >
                  mobile only
                </span>
              )}
              {lead.seen_on === 'both' && (
                <span
                  className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800"
                  title="Cross-device: same URL was seen in BOTH the desktop and mobile SERP passes."
                >
                  desktop + mobile
                </span>
              )}
              {lead.seen_on === 'desktop' && (
                <span
                  className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700"
                  title="Desktop-only: this URL was only seen in the desktop SERP pass."
                >
                  desktop only
                </span>
              )}
            </span>
          }
        />
        <KV label="Batch" value={lead.batch_id != null ? String(lead.batch_id) : '—'} />
        <KV label="Scraped" value={new Date(lead.created_at).toLocaleString()} />
        {(lead.queued_by_display || lead.queued_by_username) && (
          <KV
            label="Queued by"
            value={
              <span
                className="inline-flex items-center gap-1"
                title={lead.queued_by_username ?? undefined}
              >
                <User className="h-3 w-3 text-[color:var(--color-text-secondary)]" />
                {lead.queued_by_display || lead.queued_by_username}
              </span>
            }
          />
        )}
        {lead.scrape_job_id && (
          <KV
            label="Scrape job"
            value={
              <Link
                href={`/scrape/${lead.scrape_job_id}`}
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ExternalLink className="h-3 w-3" />
                Open job
              </Link>
            }
          />
        )}
      </Section>

      <Section title="Monday duplicate check">
        <KV
          label="On Monday?"
          value={
            lead.is_on_monday === null
              ? '—'
              : lead.is_on_monday
                ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span>{lead.monday_board ?? 'Yes'}</span>
                    <MatchKindBadge kind={lead.monday_match_kind} />
                  </span>
                )
                : 'No'
          }
        />
        {lead.monday_item_id && (
          <KV label="Item ID" value={lead.monday_item_id} />
        )}
        {lead.is_on_monday !== true && (detail.monday_candidates?.length ?? 0) > 0 && (
          <PossibleMondayMatches leadId={lead.id} candidates={detail.monday_candidates} />
        )}
      </Section>

      {detail.serp_screenshot_url && (
        <SerpScreenshotSection url={detail.serp_screenshot_url} />
      )}

      {(detail.screenshot_url || lead.result_type === 'PPC') && (
        <ScreenshotSection
          leadId={lead.id}
          url={detail.screenshot_url}
          isPPC={lead.result_type === 'PPC'}
        />
      )}

      {showAffiliate && (
      <Section title="Affiliate detection">
        <KV
          label="Is affiliate?"
          value={
            lead.is_affiliate === null ? (
              '—'
            ) : (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {`${lead.is_affiliate ? 'Yes' : 'No'}${lead.affiliate_confidence ? ` · ${lead.affiliate_confidence}` : ''}`}
                {lead.affiliate_source === 'monday' && <MondayBadge title="Affiliate status identified from the matched Monday.com item, not our enrichment." />}
              </span>
            )
          }
        />
        {lead.affiliate_score != null && (
          <KV
            label="Score"
            value={`affiliate ${lead.affiliate_score} · casino ${lead.affiliate_casino_score ?? 0} · ${lead.affiliate_external_links ?? 0} outbound`}
          />
        )}
        {lead.affiliate_indicators && lead.affiliate_indicators.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-[color:var(--color-text-secondary)]">
            {lead.affiliate_indicators.map((ind, i) => (
              <li key={i}>
                <Indicator text={ind} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      )}

      {showRooster && (
      <Section title="Rooster brand check">
        <KV
          label="Rooster partner?"
          value={
            lead.is_rooster_partner === null ? (
              '—'
            ) : (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {lead.is_rooster_partner ? (lead.brand ?? 'Yes') : 'No'}
                {lead.rooster_source === 'monday' && <MondayBadge title="Rooster-partner status identified from the matched Monday.com item, not our enrichment." />}
              </span>
            )
          }
        />
        {lead.rooster_brands && lead.rooster_brands.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {lead.rooster_brands.map((b, i) => (
              <li key={i} className="text-[color:var(--color-text-primary)]">
                <span className="font-medium">{b.domain}</span>
                {b.brand_name && <span className="text-[color:var(--color-text-secondary)]"> — {b.brand_name}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      )}

      {/* Positive callout: promotes one of our brands (Rooster partner) but
          isn't recorded on Monday yet — i.e. a fresh affiliate to onboard.
          Only fires when both signals agree, sitting right under the two
          checks (On Monday? + Rooster partner?) it draws from. */}
      {lead.is_rooster_partner === true && lead.is_on_monday !== true && (
        <section className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-900">
            <span aria-hidden="true">🎯</span>
            New affiliate candidate
          </div>
          <p className="mt-0.5 text-[11px] text-emerald-800">
            Promotes one of our brands but isn&apos;t on Monday yet — a lead to
            onboard.
          </p>
        </section>
      )}

      {showContacts && (
        <Section title="Contacts">
          <ContactsBody contact={detail.contact!} />
        </Section>
      )}

      {showStags && (
      <Section title={`S-tags (${detail.stags.length})`}>
        {detail.stags.length === 0 ? (
          <p className="text-[color:var(--color-text-secondary)]">None extracted.</p>
        ) : (
          <ul className="space-y-2">
            {detail.stags.map((t, i) => (
              <li key={i} className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-1.5 font-mono font-semibold text-[color:var(--color-text-primary)]">
                  <Tag className="h-3 w-3" />
                  <span>{t.source_param ?? 'tag'}={t.s_tag}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    {t.is_rooster_brand && (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-800">
                        Rooster brand
                      </span>
                    )}
                    {t.origin === 'monday' && <MondayBadge title="Tracking id inherited from the matched Monday.com item." />}
                    {t.is_existing_on_monday === true && (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-800">
                        on Monday
                      </span>
                    )}
                    {t.is_existing_on_monday === false && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800">
                        new
                      </span>
                    )}
                    {t.extracted_via === 'mobile' && (
                      <span
                        className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-800"
                        title="Tag was only visible when the page was rendered with an iPhone UA + 375x812 viewport — desktop pass returned zero tracking links."
                      >
                        via mobile
                      </span>
                    )}
                  </span>
                </div>
                {t.brand && (
                  <p className="mt-0.5 text-[color:var(--color-text-secondary)]">
                    Brand: <span className="text-[color:var(--color-text-primary)]">{t.brand}</span>
                  </p>
                )}
                {t.final_url && (
                  <p className="mt-0.5 truncate text-[color:var(--color-text-secondary)]" title={t.final_url}>
                    Final:{' '}
                    <a
                      href={t.final_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[color:var(--color-text-primary)] underline underline-offset-2"
                    >
                      {t.final_url.length > 60 ? t.final_url.slice(0, 60) + '…' : t.final_url}
                    </a>
                  </p>
                )}
                {t.tracking_url && t.tracking_url !== t.final_url && (
                  <p className="mt-0.5 truncate text-[color:var(--color-text-secondary)]" title={t.tracking_url}>
                    Tracking: {t.tracking_url.length > 60 ? t.tracking_url.slice(0, 60) + '…' : t.tracking_url}
                  </p>
                )}
                {Array.isArray(t.redirect_chain) && t.redirect_chain.length > 1 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
                      Redirect chain ({t.redirect_chain.length} hops)
                    </summary>
                    <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[10px] text-[color:var(--color-text-secondary)]">
                      {t.redirect_chain.map((step, j) => (
                        <li key={j} className="break-all">{step}</li>
                      ))}
                    </ol>
                  </details>
                )}
                {t.screenshot_url && (
                  <a
                    href={t.screenshot_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                  >
                    <ExternalLink className="h-3 w-3" />
                    View landing-page screenshot
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      )}

      {showCohort && (
      <Section
        title={`Owner network (${detail.cohort.length})`}
        subtitle="Other sites sharing at least one s-tag value — a strong signal of a common operator."
      >
        {detail.cohort.length === 0 ? null : (
          <ul className="space-y-1.5">
            {detail.cohort.map(sib => {
              const display = sib.domain || sib.url || `lead #${sib.lead_id}`
              // A sibling is another WEBSITE, so it links to that
              // website's page rather than reopening a per-lead view.
              const host = cleanDomain(sib.domain ?? sib.url ?? null)
              return (
                <li key={sib.lead_id}>
                  <Link
                    href={`/websites/${encodeURIComponent(host)}`}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-[color:var(--color-bg-primary)]"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-[color:var(--color-text-primary)]">
                        {display}
                      </span>
                      <span className="text-[10px] text-[color:var(--color-text-secondary)]">
                        {sib.country_code ?? '—'} · {sib.shared_count} shared{' '}
                        {sib.shared_count === 1 ? 's-tag' : 's-tags'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {sib.is_rooster_partner && (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-800">
                          Rooster
                        </span>
                      )}
                      <span className="rounded-full bg-[color:var(--color-bg-primary)] px-2 py-0.5 font-mono text-[10px] text-[color:var(--color-text-secondary)]">
                        ×{sib.shared_count}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
      )}
    </div>
  )
}

/**
 * One affiliate-detection indicator.
 *
 * Some of these are a scraper stack trace rather than a finding — a
 * multi-line SOCKS proxy error was rendering in full and swamping the
 * card. Long ones collapse to a summary you can open.
 */
function Indicator({ text }: { text: string }) {
  const long = text.length > 140 || /[\r\n]/.test(text)
  if (!long) return <>{text}</>
  const head = text.split(/[\r\n]/)[0]!.slice(0, 120)
  return (
    <details>
      <summary className="cursor-pointer marker:text-[color:var(--color-text-secondary)]">
        {head}…
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[color:var(--color-bg-secondary)] p-2 text-[10px]">
        {text}
      </pre>
    </details>
  )
}

/** Fuzzy "possible Monday matches" surfaced when the exact matcher found
 *  nothing. The operator eyeballs each candidate and confirms the right one,
 *  which sets a manual override (persists across future scrapes). */
function PossibleMondayMatches({
  leadId,
  candidates,
}: {
  leadId: number
  candidates: MondayCandidate[]
}) {
  const [pending, startTransition] = useTransition()
  const [confirmedId, setConfirmedId] = useState<string | null>(null)
  const BOARD_LABEL: Record<string, string> = {
    affiliates: 'Affiliates',
    leads: 'Leads',
    not_relevant_leads: 'Not Relevant',
    email_undelivered_leads: 'Email Undelivered',
  }
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[11px]">
      <p className="mb-1.5 font-medium text-amber-900">
        Possible Monday matches — not an exact hit, so validate before trusting
      </p>
      <ul className="flex flex-col gap-1.5">
        {candidates.map(c => (
          <li
            key={`${c.board}:${c.item_id}`}
            className="flex items-start justify-between gap-2 rounded bg-[color:var(--color-bg-primary)] px-2 py-1.5"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium text-[color:var(--color-text-primary)]">
                {c.item_name || c.website || c.item_id}
              </span>
              <span className="block truncate text-[10px] text-[color:var(--color-text-secondary)]">
                {(BOARD_LABEL[c.board] ?? c.board)} · matched on {c.matched_on}
                {c.website ? ` · ${c.website}` : ''}
              </span>
            </span>
            {confirmedId === c.item_id ? (
              <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800">
                Confirmed ✓
              </span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const fd = new FormData()
                  fd.set('lead_id', String(leadId))
                  fd.set('board', c.board)
                  fd.set('item_id', c.item_id)
                  startTransition(async () => {
                    await confirmMondayCandidate(fd)
                    setConfirmedId(c.item_id)
                  })
                }}
                className="shrink-0 rounded bg-[color:var(--color-accent)] px-2 py-1 text-[10px] font-medium text-white disabled:opacity-50"
              >
                This one
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SerpScreenshotSection({ url }: { url: string }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        Ad creative (SERP)
      </h3>
      <p className="text-[10px] italic text-[color:var(--color-text-secondary)]">
        Captured on Google&apos;s search results page — the small ad
        creative as it appeared to a searcher. The post-click landing
        page is captured separately below (when the advertiser
        doesn&apos;t cloak it).
      </p>
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1.5 inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <ExternalLink className="h-3 w-3" />
          Open full size
        </a>
        <div className="overflow-hidden rounded-sm border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="SERP ad screenshot" className="w-full" loading="lazy" />
        </div>
      </div>
    </section>
  )
}

function ScreenshotSection({
  leadId,
  url,
  isPPC,
}: {
  leadId: number
  url: string | null
  isPPC: boolean
}) {
  const [pending, startTransition] = useTransition()
  function onDelete() {
    if (!confirm('Delete this screenshot? You can re-run affiliate detection to capture a fresh one.')) return
    const fd = new FormData()
    fd.set('lead_id', String(leadId))
    startTransition(async () => {
      try {
        await deleteLeadScreenshot(fd)
        invalidateLeadDetailCache(leadId)
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          {isPPC ? 'Landing page (post-click)' : 'Landing page'}
        </h3>
        {url && (
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            {pending ? 'Deleting…' : 'Delete'}
          </button>
        )}
      </div>
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-2">
        {url ? (
          <>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-1.5 inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            >
              <ExternalLink className="h-3 w-3" />
              Open full size
            </a>
            <div className="overflow-hidden rounded-sm border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt="Lead page screenshot"
                className="w-full"
                loading="lazy"
              />
            </div>
          </>
        ) : (
          <p className="text-[11px] text-[color:var(--color-text-secondary)]">
            {isPPC
              ? 'Landing page screenshot unavailable — most likely the advertiser uses a cloaker that blocks bot screenshots after the click. The SERP ad creative above is always captured.'
              : 'No screenshot.'}
          </p>
        )}
      </div>
    </section>
  )
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {title}
      </h3>
      {subtitle && (
        <p className="text-[10px] text-[color:var(--color-text-secondary)]">{subtitle}</p>
      )}
      <div className="flex flex-col gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2">
        {children}
      </div>
    </section>
  )
}

function MatchKindBadge({ kind }: { kind: string | null }) {
  if (!kind || kind === 'exact') return null
  const styles: Record<string, { label: string; cls: string; title: string }> = {
    registered: {
      label: 'subdomain match',
      cls: 'bg-amber-100 text-amber-800',
      title: 'Matched on the registered domain (eTLD+1) — the lead is a subdomain variant of the Monday item.',
    },
    exact_name: {
      label: 'item-title match',
      cls: 'bg-violet-100 text-violet-800',
      title: 'Matched on the Monday item’s title — the brand domain is the item name and the Website column on Monday wasn’t filled in.',
    },
    registered_name: {
      label: 'item-title subdomain',
      cls: 'bg-violet-100 text-violet-800',
      title: 'Matched on the registered domain of the Monday item’s title — the lead is a subdomain variant of a title-only Monday item (Website column empty).',
    },
    mentioned_in_updates: {
      label: 'in updates',
      cls: 'bg-sky-100 text-sky-800',
      title: 'Matched a domain mentioned in a Monday board comment/post on the parent item.',
    },
  }
  const s = styles[kind] ?? { label: kind, cls: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]', title: '' }
  return (
    <span
      title={s.title}
      className={['inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide', s.cls].join(' ')}
    >
      {s.label}
    </span>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="shrink-0 text-[11px] text-[color:var(--color-text-secondary)]">{label}:</dt>
      <dd className="min-w-0 flex-1 text-[11px] text-[color:var(--color-text-primary)]">{value}</dd>
    </div>
  )
}

/** Badge marking data inherited from a matched Monday.com item (v3),
 *  distinct from our own extraction/tool badges. */
function MondayBadge({ title }: { title?: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-800"
      title={title ?? 'Inherited from the matched Monday.com item — not extracted by our system.'}
    >
      Monday.com
    </span>
  )
}

// v2 provenance: map each extraction method to the human-readable tool
// that produced it, so operators can see WHICH tool found each contact.
const METHOD_TOOL: Record<string, string> = {
  mailto: 'Page HTML',
  'text-email': 'Page HTML',
  'obfuscated-email': 'Page HTML (deobfuscated)',
  'json-ld': 'Schema.org (JSON-LD)',
  tel: 'Page HTML',
  'text-phone': 'Page HTML',
  'social-anchor': 'Page link',
  'contact-link': 'Link crawl',
  'contact-form': 'Form detect',
  'address-json-ld': 'Schema.org (JSON-LD)',
  openai: 'OpenAI web search',
  hunter: 'Hunter.io',
  manual: 'Manual entry',
  monday: 'Monday.com',
}

function toolLabel(method: string): string {
  return METHOD_TOOL[method] ?? method
}

function ToolBadge({ method, confidence }: { method: string; confidence: number }) {
  const pct = Math.round((confidence ?? 0) * 100)
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-1.5 py-px text-[10px] leading-tight text-[color:var(--color-text-secondary)]">
      {toolLabel(method)}
      {Number.isFinite(pct) && pct > 0 && (
        <span className="tabular-nums text-[color:var(--color-text-secondary)]">· {pct}%</span>
      )}
    </span>
  )
}

/** Contacts drawer body. Prefers the v2 per-item provenance view (which
 *  tool found each contact + where) and falls back to the flat
 *  emails/phones arrays for legacy rows that predate the items column. */
function ContactsBody({ contact }: { contact: LeadDetail['contact'] }) {
  if (!contact) return null
  const items = Array.isArray(contact.items) ? (contact.items as ContactItemDetail[]) : []
  const emailItems = items.filter(i => i.kind === 'email')
  const phoneItems = items.filter(i => i.kind === 'phone')
  const linkItems = items.filter(i => i.kind === 'contact_link')
  const formItems = items.filter(i => i.kind === 'contact_form')
  const socials = Array.isArray(contact.socials) ? contact.socials : []

  // Legacy fallback: no per-item rows captured (pre-v2 extraction).
  const useLegacy = items.length === 0
  const legacyEmails = contact.emails ?? []
  const legacyPhones = contact.phones ?? []

  const nothing =
    useLegacy &&
    legacyEmails.length === 0 &&
    legacyPhones.length === 0 &&
    !contact.contact_page_url &&
    socials.length === 0 &&
    !contact.address

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <KV label="Source" value={contact.source} />
        </div>
        {!nothing && <CopyContactsButton text={buildContactText(contact)} />}
      </div>

      {/* ---- Emails ---- */}
      {emailItems.length > 0 && (
        <ContactGroup label="Emails">
          {emailItems.map((it, i) => (
            <ContactRow key={i} icon={<Mail className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />} method={it.method} confidence={it.confidence} sourceUrl={it.sourceUrl}>
              <a href={`mailto:${it.value}`} className="break-all underline underline-offset-2">{it.value}</a>
            </ContactRow>
          ))}
        </ContactGroup>
      )}
      {useLegacy && legacyEmails.length > 0 && (
        <ContactGroup label="Emails">
          {legacyEmails.map((e, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[11px]">
              <Mail className="h-3 w-3 text-[color:var(--color-text-secondary)]" />
              <a href={`mailto:${e}`} className="break-all underline underline-offset-2">{e}</a>
            </li>
          ))}
        </ContactGroup>
      )}

      {/* ---- Phones ---- */}
      {phoneItems.length > 0 && (
        <ContactGroup label="Phones">
          {phoneItems.map((it, i) => (
            <ContactRow key={i} icon={<Phone className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />} method={it.method} confidence={it.confidence} sourceUrl={it.sourceUrl}>
              <a href={`tel:${it.value}`} className="underline underline-offset-2">{it.value}</a>
            </ContactRow>
          ))}
        </ContactGroup>
      )}
      {useLegacy && legacyPhones.length > 0 && (
        <ContactGroup label="Phones">
          {legacyPhones.map((p, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[11px]">
              <Phone className="h-3 w-3 text-[color:var(--color-text-secondary)]" />
              {p}
            </li>
          ))}
        </ContactGroup>
      )}

      {/* ---- Socials ---- */}
      {socials.length > 0 && (
        <ContactGroup label="Social / messaging">
          {socials.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[11px]">
              <Globe className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
                {s.url}
              </a>
              <span className="rounded-full border border-[color:var(--color-border)] px-1.5 py-px text-[10px] capitalize text-[color:var(--color-text-secondary)]">
                {s.platform}
              </span>
            </li>
          ))}
        </ContactGroup>
      )}

      {/* ---- Contact links ---- */}
      {linkItems.length > 0 ? (
        <ContactGroup label="Contact pages">
          {linkItems.map((it, i) => (
            <ContactRow key={i} icon={<Link2 className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />} method={it.method} confidence={it.confidence}>
              <a href={it.value} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
                {it.label || it.value}
              </a>
            </ContactRow>
          ))}
        </ContactGroup>
      ) : (
        contact.contact_page_url && (
          <KV
            label="Contact page"
            value={
              <a href={contact.contact_page_url} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
                {contact.contact_page_url}
              </a>
            }
          />
        )
      )}

      {/* ---- Contact forms ---- */}
      {formItems.length > 0 && (
        <ContactGroup label="Contact forms">
          {formItems.map((it, i) => (
            <ContactRow key={i} icon={<FileText className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />} method={it.method} confidence={it.confidence}>
              <a href={it.value} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
                {it.label || it.value}
              </a>
            </ContactRow>
          ))}
        </ContactGroup>
      )}

      {/* ---- Address ---- */}
      {contact.address && (
        <div className="flex items-start gap-1.5 text-[11px]">
          <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />
          <span className="text-[color:var(--color-text-primary)]">{contact.address}</span>
        </div>
      )}

      {nothing && <p className="text-[color:var(--color-text-secondary)]">No contacts found.</p>}
    </>
  )
}

function ContactGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mt-1 text-[color:var(--color-text-secondary)]">{label}</p>
      <ul className="space-y-1">{children}</ul>
    </div>
  )
}

function ContactRow({
  icon,
  method,
  confidence,
  sourceUrl,
  children,
}: {
  icon: React.ReactNode
  method: string
  confidence: number
  sourceUrl?: string
  children: React.ReactNode
}) {
  return (
    <li className="text-[11px]">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="min-w-0 flex-1 break-all text-[color:var(--color-text-primary)]">{children}</span>
        <ToolBadge method={method} confidence={confidence} />
      </div>
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-[18px] block truncate text-[10px] text-[color:var(--color-text-secondary)] underline underline-offset-2"
          title={sourceUrl}
        >
          found on {sourceUrl}
        </a>
      )}
    </li>
  )
}

/** Flatten a contact record into a plain-text block operators can paste
 *  into Monday / a CRM / an email. Prefers the v2 items[] and annotates
 *  each line with the tool that found it; falls back to the flat arrays. */
function buildContactText(contact: NonNullable<LeadDetail['contact']>): string {
  const lines: string[] = []
  const items = Array.isArray(contact.items) ? (contact.items as ContactItemDetail[]) : []
  if (items.length > 0) {
    for (const it of items) {
      const via = ` [${toolLabel(it.method)}]`
      const where = it.sourceUrl ? ` — ${it.sourceUrl}` : ''
      lines.push(`${it.label ? it.label + ': ' : ''}${it.value}${via}${where}`)
    }
  } else {
    for (const e of contact.emails ?? []) lines.push(e)
    for (const p of contact.phones ?? []) lines.push(p)
    if (contact.contact_page_url) lines.push(contact.contact_page_url)
  }
  for (const s of contact.socials ?? []) lines.push(`${s.platform}: ${s.url}`)
  if (contact.address) lines.push(`Address: ${contact.address}`)
  return lines.join('\n')
}

function CopyContactsButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {})
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)]"
      title="Copy all contacts (with tool + source) to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function MemoryPanel({
  leadId,
  inheritedFromLeadId,
  inheritedAt,
  isOnMonday,
  mondayBoard,
  isNotRelevant,
  forceEnrich,
}: {
  leadId: number
  inheritedFromLeadId: number
  inheritedAt: string | null
  isOnMonday: boolean
  mondayBoard: string | null
  isNotRelevant: boolean
  forceEnrich: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function onForceEnrich() {
    startTransition(async () => {
      const result = await forceEnrichLeadsAction([leadId])
      if (result.ok) {
        setMessage({
          ok: true,
          text:
            result.queued > 0
              ? 'Queued — enrichment will refresh this lead on the next chain tick (~30s).'
              : 'Already queued — the previous request is still in flight.',
        })
        invalidateLeadDetailCache(leadId)
      } else {
        setMessage({ ok: false, text: result.error })
      }
    })
  }

  // Reason this lead was auto-skipped from enrichment. We compute a
  // friendly label rather than show the raw boolean trio so the
  // operator knows WHY the data is from memory (Monday vs prior
  // local scrape) at a glance.
  const reason = isOnMonday
    ? mondayBoard === 'affiliates'
      ? 'Already a confirmed affiliate on Monday'
      : mondayBoard === 'not_relevant_leads'
        ? 'Already on Monday Not Relevant board'
        : 'Already on Monday'
    : isNotRelevant
      ? 'Previously flagged not-relevant'
      : 'Same domain seen in an earlier scrape'

  const inheritedDate = inheritedAt
    ? new Date(inheritedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null

  return (
    <section className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-violet-900">
            <Brain className="h-3.5 w-3.5" />
            Memory
            {forceEnrich && (
              <span className="rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                Force-enrich queued
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-violet-800">
            {reason}.{' '}
            {inheritedDate ? `Last enriched ${inheritedDate}.` : ''} Showing
            inherited data — no new fetches consumed bandwidth on this scrape.{' '}
            <Link
              href={`/leads?lead=${inheritedFromLeadId}`}
              className="underline underline-offset-2"
            >
              View original
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={onForceEnrich}
          disabled={pending || forceEnrich}
          className="inline-flex items-center gap-1.5 rounded-md border border-violet-300 bg-white px-2.5 py-1 text-[11px] font-medium text-violet-900 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
          title="Override the auto-skip and re-enrich this lead with a fresh fetch"
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Zap className="h-3 w-3" />
          )}
          {forceEnrich ? 'Queued' : 'Force enrich'}
        </button>
      </div>
      {message && (
        <p
          className={[
            'mt-2 rounded-md px-2 py-1 text-[11px]',
            message.ok ? 'bg-emerald-100 text-emerald-900' : 'bg-red-100 text-red-800',
          ].join(' ')}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

/**
 * Not-relevant is a verdict about the WEBSITE — a news site doesn't become
 * relevant because a different keyword turned it up — so the flag goes on
 * every appearance at once and onto the profile the next scrape reads.
 * The optional Monday push still creates a single item, as it always did.
 */
function NotRelevantPanel({
  leadId,
  leadIds,
  domain,
  isNotRelevant,
  markedAt,
  markedBy,
}: {
  leadId: number
  leadIds: number[]
  domain: string
  isNotRelevant: boolean
  markedAt: string | null
  markedBy: string | null
}) {
  const ids = leadIds.length > 0 ? leadIds.join(',') : String(leadId)
  const n = leadIds.length || 1
  const initial: WebsiteActionState = { status: 'idle' }
  const [state, action, pending] = useActionState(setWebsiteNotRelevantAction, initial)
  const pushInitial: PushNotRelevantState = null
  const [pushState, pushAction, pushPending] = useActionState(
    pushLeadToMondayNotRelevantAction,
    pushInitial,
  )
  const [confirming, setConfirming] = useState(false)
  // Default true — most operators want the Monday-side record too,
  // and the prompt's UX clearer when the heavier action is the
  // default rather than buried.
  const [alsoPushToMonday, setAlsoPushToMonday] = useState(true)

  useEffect(() => {
    if (state.status === 'ok') invalidateLeadDetailCache(leadId)
  }, [state, leadId])

  useEffect(() => {
    if (pushState?.status === 'ok') invalidateLeadDetailCache(leadId)
  }, [pushState, leadId])

  // Optimistic flip — server action revalidates the lead drawer's data
  // source on next open, but the panel updates immediately so the user
  // sees the new state. Action returns the new value so toggling back
  // and forth in the same drawer session lands on the right UI.
  const effectivelyHidden = state?.status === 'ok' ? state.message.startsWith('Marked') : isNotRelevant

  if (effectivelyHidden) {
    return (
      <section className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2">
        <EyeOff className="h-4 w-4 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-amber-900">
            Marked as not relevant
          </p>
          <p className="truncate text-[10px] text-amber-800/80">
            Hidden from /leads · skipped by enrichment · {n} appearance{n === 1 ? '' : 's'}
            {markedAt ? ` · ${new Date(markedAt).toLocaleString()}` : ''}
            {markedBy ? ` · by ${markedBy}` : ''}
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="lead_ids" value={ids} />
          <input type="hidden" name="domain" value={domain} />
          <input type="hidden" name="value" value="false" />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-[10px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Restore
          </button>
        </form>
      </section>
    )
  }

  // Collapsed, this is one button. The explanation appears only once the
  // operator has said they mean it — reading three paragraphs about what
  // the buttons do before seeing the website was the old drawer's problem.
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title={`Hides this website from /leads across all ${n} appearance${n === 1 ? '' : 's'}, cancels in-flight enrichment, and stops future passes picking it up. Reversible.`}
        className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
      >
        <EyeOff className="h-3 w-3" />
        Mark not relevant
      </button>
    )
  }

  return (
    <section className="flex w-full max-w-[520px] flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        Not relevant?
      </p>
      <p className="text-[10px] text-[color:var(--color-text-secondary)]">
        Hides this website from /leads across all {n} appearance{n === 1 ? '' : 's'},
        cancels in-flight enrichment, and stops future passes picking it up.
        Reversible.
      </p>
      {confirming && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50/50 px-2.5 py-2">
          <label className="flex cursor-pointer items-start gap-2 text-[11px] text-amber-900">
            <input
              type="checkbox"
              checked={alsoPushToMonday}
              onChange={e => setAlsoPushToMonday(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-amber-700"
            />
            <span>
              <strong>Also push to Monday Not Relevant board</strong>
              <span className="block text-[10px] text-amber-800/80">
                Recommended — adds a permanent record so future scrapes of the
                same domain auto-skip via the Monday duplicate check, not just
                the local flag.
              </span>
            </span>
          </label>
          {alsoPushToMonday ? (
            <form action={pushAction} className="flex items-center gap-2">
              <input type="hidden" name="lead_id" value={leadId} />
              <button
                type="submit"
                disabled={pushPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pushPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                Push to Monday + mark not relevant
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pushPending}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] hover:bg-[color:var(--color-bg-secondary)]"
              >
                Cancel
              </button>
            </form>
          ) : (
            <form action={action} className="flex items-center gap-2">
              <input type="hidden" name="lead_ids" value={ids} />
              <input type="hidden" name="domain" value={domain} />
              <input type="hidden" name="value" value="true" />
              <button
                type="submit"
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <EyeOff className="h-3 w-3" />}
                Confirm (local only)
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] hover:bg-[color:var(--color-bg-secondary)]"
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
      {state.status === 'error' && (
        <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
      {pushState?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {pushState.error}
        </p>
      )}
      {pushState?.status === 'ok' && (
        <p className="rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
          {pushState.message}
        </p>
      )}
    </section>
  )
}

/**
 * Standalone "Push to Monday Not Relevant" button — sits between
 * the Not-Relevant panel and the regular Push-to-Monday panel.
 * Click expands a comment textarea (mirrors the regular Push-to-
 * Monday panel) so the operator can leave context before confirming.
 * The push creates a new item on Monday's Not Relevant board with
 * status="Not relevant" and Owner set to the operator's Monday user.
 */
function PushNotRelevantButton({ leadId }: { leadId: number }) {
  const initial: PushNotRelevantState = null
  const [state, action, pending] = useActionState(
    pushLeadToMondayNotRelevantAction,
    initial,
  )
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (state?.status === 'ok') invalidateLeadDetailCache(leadId)
  }, [state, leadId])

  // Collapsed to a button; the explanation lives in the tooltip until the
  // operator opens the form.
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending}
        title="Adds the domain to Monday's Not Relevant board (status 'Not relevant', assigned to you) and marks it not-relevant locally. Future scrapes of the same domain auto-skip."
        className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Send className="h-3 w-3" />
        Push to Not Relevant
      </button>
    )
  }

  return (
    <section className="w-full max-w-[520px] rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-amber-900">
            Push to Monday — Not Relevant
          </p>
          <p className="mt-0.5 text-[10px] text-amber-800">
            Adds the domain to Monday&apos;s Not Relevant board (status
            <em> Not relevant</em>, assigned to you) and marks it
            not-relevant locally. Future scrapes of the same domain
            auto-skip.
          </p>
        </div>
      </div>

      {confirming && (
        <form action={action} className="mt-2 flex flex-col gap-2">
          <input type="hidden" name="lead_id" value={leadId} />
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium text-amber-900">
              Comment (optional) — fills the item&apos;s Comments column
              on Monday
            </span>
            <textarea
              name="note"
              rows={3}
              maxLength={MAX_OPERATOR_NOTE_LEN}
              disabled={pending}
              placeholder="Why was this flagged as not relevant? Left blank, nothing extra is posted."
              className="w-full resize-y rounded-md border border-amber-300 bg-white px-2 py-1.5 text-[11px] text-amber-900 placeholder:text-amber-700/60 focus:border-amber-500 focus:outline-none disabled:opacity-50"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-400 bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Confirm push
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] text-amber-900 hover:bg-amber-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {state?.status === 'error' && (
        <p className="mt-2 rounded-md bg-red-100 px-2 py-1 text-[11px] text-red-800">
          {state.error}
        </p>
      )}
      {state?.status === 'ok' && (
        <p className="mt-2 rounded-md bg-emerald-100 px-2 py-1 text-[11px] text-emerald-900">
          {state.message}
        </p>
      )}
    </section>
  )
}

function PushToMondayPanel({
  leadId,
  pushedAt,
  pushedItemId,
  pushedBy,
}: {
  leadId: number
  pushedAt: string | null
  pushedItemId: string | null
  pushedBy: string | null
}) {
  const initial: PushToMondayState = null
  const [state, action, pending] = useActionState(pushLeadToMondayAction, initial)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (state?.status === 'ok') invalidateLeadDetailCache(leadId)
  }, [state, leadId])

  // After a successful push the row's pushedAt won't reflect immediately
  // (drawer fetches its own data via /api/leads/[id]) — but the action
  // returns the new item_id so we can switch to "already pushed" UI right
  // away.
  const successItemId =
    state?.status === 'ok' ? state.monday_item_id : null
  const effectivePushedAt = pushedAt ?? (state?.status === 'ok' ? new Date().toISOString() : null)
  const effectiveItemId = pushedItemId ?? successItemId

  if (effectivePushedAt) {
    return (
      <section className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-emerald-800">
            Pushed to Monday
          </p>
          <p className="truncate text-[10px] text-emerald-700/80">
            Item {effectiveItemId} · {new Date(effectivePushedAt).toLocaleString()}
            {pushedBy ? ` · by ${pushedBy}` : ''}
          </p>
        </div>
      </section>
    )
  }

  // Collapsed to a button, like the other two — the detail of what gets
  // written to Monday appears with the form.
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title="Creates a new item on the Leads board with this lead's keyword, country, URL, source, primary contact email, and (if present) attaches the screenshot + posts s-tags as an item update."
        className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30"
      >
        <Send className="h-3 w-3" />
        Push to Monday
      </button>
    )
  }

  return (
    <section className="flex w-full max-w-[520px] flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        Push to Monday
      </p>
      <p className="text-[10px] text-[color:var(--color-text-secondary)]">
        Creates a new item on the <em>Leads</em> board with this lead&apos;s
        keyword, country, URL, source, primary contact email, and (if
        present) attaches the screenshot + posts s-tags as an item update.
      </p>
      {confirming && (
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="lead_id" value={leadId} />
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium text-[color:var(--color-text-secondary)]">
              Comment (optional) — fills the item&apos;s Comments column on Monday
            </span>
            <textarea
              name="note"
              rows={3}
              maxLength={MAX_OPERATOR_NOTE_LEN}
              disabled={pending}
              placeholder="Add any context for the team — left blank, nothing extra is posted."
              className="w-full resize-y rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[11px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)]/60 focus:border-[color:var(--color-accent)] focus:outline-none disabled:opacity-50"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/30 px-2.5 py-1 text-[11px] font-semibold hover:bg-[color:var(--color-accent)]/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Confirm push
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] hover:bg-[color:var(--color-bg-secondary)]"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {state?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
    </section>
  )
}
