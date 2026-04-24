'use client'

import { useEffect, useState } from 'react'
import { X, ExternalLink, Mail, Phone, Tag } from 'lucide-react'
import { getLeadDetails } from '../actions'

type Detail = Awaited<ReturnType<typeof getLeadDetails>>

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
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
     
    setError(null)
    getLeadDetails(leadId)
      .then(d => {
        if (!cancelled) setDetail(d)
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [leadId])

  // When the drawer closes, clear stale state so a subsequent re-open
  // shows a loading state instead of the previous lead's data.
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
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30"
      />
      {/* Drawer */}
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[460px] flex-col border-l border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-[color:var(--color-text-primary)]">
              {lead?.domain ?? '—'}
            </p>
            {lead?.url && (
              <a
                href={lead.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                <ExternalLink className="h-3 w-3" />
                {lead.url.length > 60 ? lead.url.slice(0, 60) + '…' : lead.url}
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
      <Section title="Context">
        <KV label="Keyword" value={lead.keyword ?? '—'} />
        <KV label="Country" value={[lead.country, lead.country_code].filter(Boolean).join(' · ') || '—'} />
        <KV label="Type" value={lead.result_type ?? '—'} />
        <KV label="Batch" value={lead.batch_id != null ? String(lead.batch_id) : '—'} />
        <KV label="Scraped" value={new Date(lead.created_at).toLocaleString()} />
      </Section>

      <Section title="Monday duplicate check">
        <KV label="On Monday?" value={lead.is_on_monday === null ? '—' : lead.is_on_monday ? (lead.monday_board ?? 'Yes') : 'No'} />
        {lead.monday_item_id && (
          <KV label="Item ID" value={lead.monday_item_id} />
        )}
      </Section>

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
                <div className="flex items-center gap-1.5 font-mono font-semibold text-[color:var(--color-text-primary)]">
                  <Tag className="h-3 w-3" />
                  <span>{t.source_param ?? 'tag'}={t.s_tag}</span>
                  {t.is_existing_on_monday === true && (
                    <span className="ml-auto rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-800">
                      on Monday
                    </span>
                  )}
                  {t.is_existing_on_monday === false && (
                    <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800">
                      new
                    </span>
                  )}
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
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
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

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="shrink-0 text-[11px] text-[color:var(--color-text-secondary)]">{label}:</dt>
      <dd className="min-w-0 flex-1 text-[11px] text-[color:var(--color-text-primary)]">{value}</dd>
    </div>
  )
}
