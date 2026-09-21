import Link from 'next/link'

/**
 * What came out of this scrape, above the table.
 *
 * Reading the verdict off 100 rows meant counting in your head. Three
 * questions get answered here instead, in the order the pipeline asks
 * them: was the result even about the keyword, do we already hold the
 * website, and how far did the affiliate work get.
 *
 * Every number is a link into the table filtered to exactly those rows, so
 * the strip is a way in rather than a decoration.
 */

export type JobAnalysisSummary = {
  total: number
  relevant: number
  off_keyword: number
  relevance_unknown: number
  on_monday: number
  in_system: number
  brand_new: number
  affiliate_yes: number
  affiliate_no: number
  affiliate_unknown: number
  rooster_partners: number
  with_contacts: number
  distinct_domains: number
}

type Props = {
  summary: JobAnalysisSummary
  /** Current querystring, so a stat link keeps the page's other params. */
  baseParams: URLSearchParams
}

export function AnalysisSummary({ summary, baseParams }: Props) {
  if (summary.total === 0) return null

  const href = (filter: string | null) => {
    const p = new URLSearchParams(baseParams)
    p.delete('f')
    p.delete('page')
    if (filter) p.set('f', filter)
    return `?${p.toString()}`
  }

  const screened = summary.relevant + summary.off_keyword
  const pct = (n: number) => (summary.total > 0 ? Math.round((n / summary.total) * 100) : 0)

  return (
    <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">
          Analysis
        </h2>
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          {summary.total.toLocaleString()} result{summary.total === 1 ? '' : 's'} ·{' '}
          {summary.distinct_domains.toLocaleString()} website
          {summary.distinct_domains === 1 ? '' : 's'}
          {screened > 0 && <> · {pct(screened)}% screened against the keyword</>}
        </p>
      </div>

      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">
        <Group title="Relevant to the keyword">
          <Stat
            label="On keyword"
            value={summary.relevant}
            tone="good"
            href={href('is_relevant:istrue')}
          />
          <Stat
            label="Off keyword"
            value={summary.off_keyword}
            tone="bad"
            href={href('is_relevant:isfalse')}
            hint="Judged from the SERP title and snippet. Skipped by the affiliate work unless forced through."
          />
          {summary.relevance_unknown > 0 && (
            <Stat
              label="Not screened"
              value={summary.relevance_unknown}
              tone="muted"
              href={href('is_relevant:empty')}
            />
          )}
        </Group>

        {/* "New" and "In system" have no filter of their own — the split
            is computed from the website profile's first sighting, not a
            column you can query. Only the Monday side is linkable. */}
        <Group title="Already exists?">
          <Stat
            label="New"
            value={summary.brand_new}
            tone="good"
            hint="Neither on a Monday board nor seen by an earlier scrape — the leads worth working."
          />
          <Stat
            label="In system"
            value={summary.in_system}
            tone="warn"
            hint="Our own database already holds this website from an earlier scrape."
          />
          <Stat
            label="On Monday"
            value={summary.on_monday}
            tone="muted"
            href={href('is_on_monday:istrue')}
          />
        </Group>

        <Group title="Affiliate check">
          <Stat
            label="Affiliate"
            value={summary.affiliate_yes}
            tone="good"
            href={href('is_affiliate:istrue')}
          />
          <Stat
            label="Not affiliate"
            value={summary.affiliate_no}
            tone="muted"
            href={href('is_affiliate:isfalse')}
          />
          {summary.rooster_partners > 0 && (
            <Stat
              label="Rooster brand"
              value={summary.rooster_partners}
              tone="good"
              href={href('is_rooster_partner:istrue')}
            />
          )}
          {summary.with_contacts > 0 && (
            <Stat
              label="Has contacts"
              value={summary.with_contacts}
              tone="good"
              href={href('has_contact_details:istrue')}
            />
          )}
          {summary.affiliate_unknown > 0 && (
            <Stat label="Unchecked" value={summary.affiliate_unknown} tone="muted" />
          )}
        </Group>
      </div>
    </section>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

const TONES: Record<string, string> = {
  good: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  bad: 'bg-rose-50 text-rose-800 border-rose-200',
  muted: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] border-[color:var(--color-border)]',
}

function Stat({
  label,
  value,
  tone,
  href,
  hint,
}: {
  label: string
  value: number
  tone: keyof typeof TONES | string
  href?: string
  hint?: string
}) {
  const cls = [
    'inline-flex items-baseline gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-none',
    TONES[tone] ?? TONES.muted,
  ].join(' ')
  const body = (
    <>
      <span className="text-[13px] font-semibold tabular-nums">{value.toLocaleString()}</span>
      <span className="font-medium">{label}</span>
    </>
  )
  // A zero is worth showing — "0 off keyword" is a real result — but it is
  // not worth clicking into.
  if (!href || value === 0) {
    return (
      <span className={cls} {...(hint ? { title: hint } : {})}>
        {body}
      </span>
    )
  }
  return (
    <Link
      href={href}
      className={`${cls} transition-opacity hover:opacity-80`}
      {...(hint ? { title: hint } : {})}
    >
      {body}
    </Link>
  )
}
