'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Brain,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  ExternalLink,
  Loader2,
  Mail,
  Phone,
  RotateCcw,
  Send,
  Tag,
  Trash2,
  User,
  X,
  Zap,
} from 'lucide-react'
import type { LeadDetail } from '../_lib/detail-query'
import {
  getCachedLeadDetail,
  invalidateLeadDetailCache,
  setCachedLeadDetail,
} from '../_lib/detail-cache'
import {
  deleteLeadScreenshot,
  forceEnrichLeadsAction,
  pushLeadToMondayAction,
  pushLeadToMondayNotRelevantAction,
  setNotRelevantAction,
  type MarkNotRelevantState,
  type PushNotRelevantState,
  type PushToMondayState,
} from '../actions'
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

async function fetchLeadDetail(leadId: number, signal: AbortSignal): Promise<Detail> {
  const res = await fetch(`/api/leads/${leadId}`, { signal, cache: 'no-store' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}


type Props = {
  leadId: number | null
  /** The ordered list of currently-visible lead ids; lets the drawer step
   *  through them with prev/next without closing. Pass an empty array if
   *  navigation isn't applicable. */
  leadIds?: number[]
  onClose: () => void
  /** Called when the user clicks the prev/next arrows. If omitted, arrows
   *  are hidden. */
  onNavigate?: (id: number) => void
  /** Called when the user clicks past the first/last visible lead. The
   *  caller is responsible for advancing to the prev/next page. */
  onBoundary?: (dir: 'prev' | 'next') => void
  canGoPrevPage?: boolean
  canGoNextPage?: boolean
}

export function LeadDetailDrawer({
  leadId,
  leadIds = [],
  onClose,
  onNavigate,
  onBoundary,
  canGoPrevPage = false,
  canGoNextPage = false,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (leadId === null) return
    const controller = new AbortController()

    // Stale-while-revalidate: if we've fetched this lead before, show
    // the cached payload immediately and skip the loader. Always re-fetch
    // in the background to pick up any server-side changes.
    const cached = getCachedLeadDetail(leadId)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(cached ?? null)

    setError(null)
    setLoading(!cached)

    fetchLeadDetail(leadId, controller.signal)
      .then(d => {
        if (controller.signal.aborted) return
        setCachedLeadDetail(leadId, d)
        setDetail(d)
      })
      .catch(e => {
        if (controller.signal.aborted) return
        // If we showed cached data and the refresh fails, keep showing
        // the cache rather than flashing an error — log it instead.
        if (cached) {
           
          console.warn('Background refresh failed for lead', leadId, e)
          return
        }
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [leadId])

  // When the drawer closes, clear UI state. We keep the module-level
  // cache so re-opening the same lead is instant.
  useEffect(() => {
    if (leadId !== null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(null)

    setError(null)
  }, [leadId])

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    if (leadId !== null) {
      document.addEventListener('keydown', onEsc)
      return () => document.removeEventListener('keydown', onEsc)
    }
  }, [leadId, onClose])

  // Keyboard shortcuts for prev/next while the drawer is open. Re-derive
  // the navigation state inside the handler so we don't have to hoist
  // goPrev/goNext above the early return; closure over latest props is
  // sufficient.
  useEffect(() => {
    if (leadId === null) return
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Spatial mapping: left key on the keyboard = previous, right = next.
      const isNext = e.key === 'ArrowRight' || e.key === 'm' || e.key === 'M'
      const isPrev = e.key === 'ArrowLeft'  || e.key === 'n' || e.key === 'N'
      if (!isNext && !isPrev) return

      const idx = leadIds.indexOf(leadId!)
      if (idx < 0) return
      const here = leadIds[idx]
      const atFirstLocal = idx === 0
      const atLastLocal = idx === leadIds.length - 1
      const prev = atFirstLocal ? null : leadIds[idx - 1] ?? null
      const next = atLastLocal ? null : leadIds[idx + 1] ?? null
      void here

      if (isNext) {
        if (next !== null) {
          e.preventDefault()
          onNavigate?.(next)
        } else if (atLastLocal && canGoNextPage) {
          e.preventDefault()
          onBoundary?.('next')
        }
        return
      }
      if (isPrev) {
        if (prev !== null) {
          e.preventDefault()
          onNavigate?.(prev)
        } else if (atFirstLocal && canGoPrevPage) {
          e.preventDefault()
          onBoundary?.('prev')
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [leadId, leadIds, onNavigate, onBoundary, canGoPrevPage, canGoNextPage])

  if (leadId === null) return null

  const lead = detail?.lead ?? null

  // Prev/next navigation. Walks the visible lead ids the table handed
  // us; at the boundary of the visible list, falls back to `onBoundary`
  // to bridge to the adjacent page (if the table indicates one exists).
  const navIndex = leadIds.indexOf(leadId)
  const inList = navIndex >= 0
  const atFirst = inList && navIndex === 0
  const atLast = inList && navIndex === leadIds.length - 1
  const prevId = inList && navIndex > 0 ? leadIds[navIndex - 1] ?? null : null
  const nextId = inList && navIndex < leadIds.length - 1 ? leadIds[navIndex + 1] ?? null : null
  const prevEnabled = prevId !== null || (atFirst && canGoPrevPage && onBoundary !== undefined)
  const nextEnabled = nextId !== null || (atLast && canGoNextPage && onBoundary !== undefined)
  const canNavigate =
    onNavigate !== undefined && inList && (leadIds.length > 1 || canGoPrevPage || canGoNextPage)

  function goPrev() {
    if (prevId !== null) onNavigate?.(prevId)
    else if (atFirst && canGoPrevPage) onBoundary?.('prev')
  }
  function goNext() {
    if (nextId !== null) onNavigate?.(nextId)
    else if (atLast && canGoNextPage) onBoundary?.('next')
  }

  return (
    <>
      {/* Drawer — no backdrop so pagination + other rows stay clickable.
          z-50 keeps it above the sidebar (z-40) and mobile backdrop (z-30). */}
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[460px] flex-col border-l border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] shadow-xl">
        <header className="flex flex-col gap-2 border-b border-[color:var(--color-border)] px-4 py-3">
          {canNavigate && (
            <div className="flex items-center gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
              <button
                type="button"
                onClick={goPrev}
                disabled={!prevEnabled}
                aria-label={prevId === null && atFirst && canGoPrevPage ? 'Previous page (N or ←)' : 'Previous lead (N or ←)'}
                title={prevId === null && atFirst && canGoPrevPage ? 'Previous page (N or ←)' : 'Previous lead (N or ←)'}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={!nextEnabled}
                aria-label={nextId === null && atLast && canGoNextPage ? 'Next page (M or →)' : 'Next lead (M or →)'}
                title={nextId === null && atLast && canGoNextPage ? 'Next page (M or →)' : 'Next lead (M or →)'}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <span className="ml-1 tabular-nums">
                {navIndex + 1} <span className="opacity-60">of {leadIds.length}</span>
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close"
                className="ml-auto rounded-md p-1 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold text-[color:var(--color-text-primary)]">
                {cleanDomain(lead?.domain ?? lead?.url ?? null)}
              </p>
              {lead?.url && (
                <a
                  href={lead.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 flex items-start gap-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                >
                  <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-all">{lead.url}</span>
                </a>
              )}
            </div>
            {!canNavigate && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-md p-1 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading && <Loading />}
          {error && <ErrorPanel message={error} />}
          {detail && !loading && !error && (
            <DetailBody detail={detail} onOpenLead={onNavigate} />
          )}
        </div>
      </aside>
    </>
  )
}

function Loading() {
  return (
    <div className="flex h-40 items-center justify-center text-[12px] text-[color:var(--color-text-secondary)]">
      Loading…
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="m-4 rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
      Error: {message}
    </div>
  )
}

function DetailBody({
  detail,
  onOpenLead,
}: {
  detail: Detail
  onOpenLead?: ((id: number) => void) | undefined
}) {
  const lead = detail.lead
  if (!lead) {
    return (
      <div className="m-4 text-[12px] text-[color:var(--color-text-secondary)]">
        Lead not found.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 text-[12px]">
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

      <NotRelevantPanel
        leadId={lead.id}
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

      <Section title="Context">
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

      <Section title="Affiliate detection">
        <KV
          label="Is affiliate?"
          value={
            lead.is_affiliate === null
              ? '—'
              : `${lead.is_affiliate ? 'Yes' : 'No'}${lead.affiliate_confidence ? ` · ${lead.affiliate_confidence}` : ''}`
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
            {lead.affiliate_indicators.map((ind, i) => <li key={i}>{ind}</li>)}
          </ul>
        )}
      </Section>

      <Section title="Rooster brand check">
        <KV
          label="Rooster partner?"
          value={lead.is_rooster_partner === null ? '—' : lead.is_rooster_partner ? (lead.brand ?? 'Yes') : 'No'}
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

      <Section title="Contacts">
        {!detail.contact ? (
          <p className="text-[color:var(--color-text-secondary)]">Not yet extracted.</p>
        ) : (
          <>
            <KV label="Source" value={detail.contact.source} />
            {detail.contact.emails && detail.contact.emails.length > 0 && (
              <div>
                <p className="mt-1 text-[color:var(--color-text-secondary)]">Emails</p>
                <ul className="space-y-0.5">
                  {detail.contact.emails.map((e, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[11px]">
                      <Mail className="h-3 w-3 text-[color:var(--color-text-secondary)]" />
                      <a href={`mailto:${e}`} className="underline underline-offset-2">{e}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detail.contact.phones && detail.contact.phones.length > 0 && (
              <div>
                <p className="mt-1 text-[color:var(--color-text-secondary)]">Phones</p>
                <ul className="space-y-0.5">
                  {detail.contact.phones.map((p, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[11px]">
                      <Phone className="h-3 w-3 text-[color:var(--color-text-secondary)]" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detail.contact.contact_page_url && (
              <KV
                label="Contact page"
                value={
                  <a
                    href={detail.contact.contact_page_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all underline underline-offset-2"
                  >
                    {detail.contact.contact_page_url}
                  </a>
                }
              />
            )}
            {(!detail.contact.emails || detail.contact.emails.length === 0) &&
              (!detail.contact.phones || detail.contact.phones.length === 0) &&
              !detail.contact.contact_page_url && (
                <p className="text-[color:var(--color-text-secondary)]">No contacts found.</p>
              )}
          </>
        )}
      </Section>

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

      <Section
        title={`Owner network (${detail.cohort.length})`}
        subtitle="Other affiliate sites that share at least one s-tag value with this lead — strong signal of common operator."
      >
        {detail.cohort.length === 0 ? (
          <p className="text-[color:var(--color-text-secondary)]">
            {detail.stags.length === 0
              ? 'No s-tags collected yet — owner network unavailable until enrichment completes.'
              : 'No other lead shares any s-tag with this one yet.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {detail.cohort.map(sib => {
              const display = sib.domain || sib.url || `lead #${sib.lead_id}`
              const Wrap: React.ElementType = onOpenLead ? 'button' : 'div'
              return (
                <li key={sib.lead_id}>
                  <Wrap
                    {...(onOpenLead
                      ? {
                          type: 'button',
                          onClick: () => onOpenLead(sib.lead_id),
                        }
                      : {})}
                    className={[
                      'flex w-full items-center justify-between gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-2.5 py-2 text-left text-[11px]',
                      onOpenLead
                        ? 'cursor-pointer transition-colors hover:bg-[color:var(--color-bg-primary)]'
                        : '',
                    ].join(' ')}
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
                  </Wrap>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
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

function NotRelevantPanel({
  leadId,
  isNotRelevant,
  markedAt,
  markedBy,
}: {
  leadId: number
  isNotRelevant: boolean
  markedAt: string | null
  markedBy: string | null
}) {
  const initial: MarkNotRelevantState = null
  const [state, action, pending] = useActionState(setNotRelevantAction, initial)
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
    if (state?.status === 'ok') invalidateLeadDetailCache(leadId)
  }, [state, leadId])

  useEffect(() => {
    if (pushState?.status === 'ok') invalidateLeadDetailCache(leadId)
  }, [pushState, leadId])

  // Optimistic flip — server action revalidates the lead drawer's data
  // source on next open, but the panel updates immediately so the user
  // sees the new state. Action returns the new value so toggling back
  // and forth in the same drawer session lands on the right UI.
  const effectivelyHidden =
    state?.status === 'ok' ? state.isNotRelevant : isNotRelevant

  if (effectivelyHidden) {
    return (
      <section className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2">
        <EyeOff className="h-4 w-4 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-amber-900">
            Marked as not relevant
          </p>
          <p className="truncate text-[10px] text-amber-800/80">
            Hidden from /leads · skipped by enrichment
            {markedAt ? ` · ${new Date(markedAt).toLocaleString()}` : ''}
            {markedBy ? ` · by ${markedBy}` : ''}
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="lead_id" value={leadId} />
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

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Not relevant?
        </p>
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            <EyeOff className="h-3 w-3" />
            Mark as not relevant
          </button>
        )}
      </div>
      <p className="text-[10px] text-[color:var(--color-text-secondary)]">
        Hides this lead from /leads, cancels in-flight enrichment for it,
        and prevents future enrichment passes from picking it up. Reversible.
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
              <input type="hidden" name="lead_id" value={leadId} />
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
      {state?.status === 'error' && (
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

  return (
    <section className="rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2.5">
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
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-3 w-3" />
            Push & mark
          </button>
        )}
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

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Push to Monday
        </p>
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30"
          >
            <Send className="h-3 w-3" />
            Push to Monday
          </button>
        )}
      </div>
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
