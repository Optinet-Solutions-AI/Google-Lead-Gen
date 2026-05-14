'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  CheckCircle2,
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
} from 'lucide-react'
import type { LeadDetail } from '../_lib/detail-query'
import {
  getCachedLeadDetail,
  invalidateLeadDetailCache,
  setCachedLeadDetail,
} from '../_lib/detail-cache'
import {
  deleteLeadScreenshot,
  pushLeadToMondayAction,
  setNotRelevantAction,
  type MarkNotRelevantState,
  type PushToMondayState,
} from '../actions'

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
  onClose: () => void
}

export function LeadDetailDrawer({ leadId, onClose }: Props) {
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

  if (leadId === null) return null

  const lead = detail?.lead ?? null

  return (
    <>
      {/* Drawer — no backdrop so pagination + other rows stay clickable.
          z-50 keeps it above the sidebar (z-40) and mobile backdrop (z-30). */}
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[460px] flex-col border-l border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3">
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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading && <Loading />}
          {error && <ErrorPanel message={error} />}
          {detail && !loading && !error && <DetailBody detail={detail} />}
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

function DetailBody({ detail }: { detail: Detail }) {
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
      <NotRelevantPanel
        leadId={lead.id}
        isNotRelevant={lead.is_not_relevant}
        markedAt={lead.not_relevant_marked_at}
        markedBy={lead.not_relevant_marked_by}
      />

      <PushToMondayPanel
        leadId={lead.id}
        pushedAt={lead.pushed_to_monday_at}
        pushedItemId={lead.monday_pushed_item_id}
        pushedBy={lead.monday_pushed_by}
      />

      <Section title="Context">
        <KV label="Keyword" value={lead.keyword ?? '—'} />
        <KV label="Country" value={[lead.country, lead.country_code].filter(Boolean).join(' · ') || '—'} />
        <KV label="Type" value={lead.result_type ?? '—'} />
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
    </div>
  )
}

function SerpScreenshotSection({ url }: { url: string }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        SERP ad screenshot
      </h3>
      <p className="text-[10px] italic text-[color:var(--color-text-secondary)]">
        Captured at scrape time on Google&apos;s results page — the small
        ad creative as it appeared to a searcher.
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
          Screenshot{isPPC ? ' · PPC' : ''}
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
              ? 'No screenshot yet — run affiliate detection on this batch and the worker will capture one.'
              : 'No screenshot.'}
          </p>
        )}
      </div>
    </section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {title}
      </h3>
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
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (state?.status === 'ok') invalidateLeadDetailCache(leadId)
  }, [state, leadId])

  // Optimistic flip — server action revalidates the lead drawer's data
  // source on next open, but the panel updates immediately so the user
  // sees the new state.
  const effectivelyHidden =
    state?.status === 'ok' ? !isNotRelevant : isNotRelevant

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
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="lead_id" value={leadId} />
          <input type="hidden" name="value" value="true" />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <EyeOff className="h-3 w-3" />}
            Confirm
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
      {state?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {state.error}
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
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="lead_id" value={leadId} />
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
