/**
 * Manifest of measurement reports surfaced in the admin area.
 *
 * Each entry points at a self-contained HTML report and carries the headline
 * figures so the list is useful without opening anything. Add a row when a new
 * measurement is run.
 *
 * The HTML lives in `/reports` at the repo root, NOT in `public/`: these
 * reports name affiliate domains, brands and contacts, and `public/` is served
 * without a session. `/api/admin/reports/[slug]` checks admin access first.
 */

export type ReportMetric = {
  label: string
  value: string
  /** Optional one-line reading of the number. */
  note?: string
  tone?: 'ok' | 'warn' | 'bad' | 'plain'
}

export type MeasurementReport = {
  slug: string
  title: string
  /** What question the measurement answered. */
  question: string
  /** The answer, in one sentence. */
  finding: string
  ranOn: string
  /** Admin-gated route that streams the HTML. */
  href: string
  sample: string
  metrics: ReportMetric[]
  /** Decisions this report should feed. */
  actions: string[]
}

export const REPORTS: ReadonlyArray<MeasurementReport> = [
  {
    slug: 'affiliate-crawl-audit-2026-09-16',
    title: 'Affiliate crawl audit',
    question: 'Can a language model read affiliate pages well enough to take enrichment off the VM?',
    finding:
      'Yes for the verdict, the brands and the contacts, at well under a cent per site. No for the CTA tracking links, which need the raw HTML.',
    ranOn: '2026-09-16',
    href: '/api/admin/reports/affiliate-crawl-audit-2026-09-16',
    sample: '175 confirmed affiliate pages, 10 per country across 19 countries, using gpt-5-mini',
    metrics: [
      { label: 'Pages read', value: '127 of 175', note: '15 blocked, 33 errored on dead or spam pages', tone: 'plain' },
      { label: 'Affiliate verdict agrees with the database', value: '91 of 127', note: 'all 36 disagreements say "not an affiliate"', tone: 'warn' },
      { label: 'Casino and betting brands extracted', value: '1,406', note: '11.1 per page', tone: 'ok' },
      { label: 'Brands with a usable CTA link', value: '10%', note: 'the text fetch cannot see anchor URLs', tone: 'bad' },
      { label: 'Cloaked links unmasked without a browser', value: '199 of 211', note: 'redirect headers, on the 10-site sample', tone: 'ok' },
      { label: 'Cost', value: '$1.04', note: 'about $0.006 per site in tokens', tone: 'ok' },
    ],
    actions: [
      'Review the 36 pages where the affiliate heuristic disagrees: operators, B2B vendors and news sites flagged with high confidence.',
      'Wire the model into the fetch-error branch of enrichment so failed rows still get a verdict.',
      'Recover CTA links from raw HTML and redirect headers rather than from the model.',
    ],
  },
]

export function reportBySlug(slug: string): MeasurementReport | null {
  return REPORTS.find(r => r.slug === slug) ?? null
}
