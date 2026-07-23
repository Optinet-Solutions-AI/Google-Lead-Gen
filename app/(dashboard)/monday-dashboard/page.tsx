import Link from 'next/link'
import { parseDateRange } from '../_lib/date-range'
import { DateRangeToggle } from '../_components/dashboards/date-range-toggle'
import { PlaceholderPanel } from '../_components/dashboards/dashboard-section'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

/**
 * Monday Analytics — aggregated dashboard over the mirrored Monday.com
 * boards (leads, updates, brand rooster, etc.). Distinct from the raw
 * item list at /monday/leads.
 *
 * Phase 1 ships this shell with the date-range toggle + section
 * placeholders. Phase 4 populates:
 *   - Today's snapshot (items mirrored, sync freshness per board)
 *   - Global performance (item-count deltas, board growth over time)
 *   - Activity trend (daily item additions per board, sync latency)
 *   - Daily × hour heatmap (when new items land vs when we mirror)
 *   - Leaderboards (top boards by activity, top brands, top S-tags)
 *   - Match ratios (S-tag → Monday match rate, unmapped-vs-mapped
 *     trend, mirror-group split)
 */
export default async function MondayDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const range = parseDateRange(sp.range)

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Monday Analytics
          </h1>
          <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
            Aggregated view over the mirrored Monday.com boards. Raw item
            list lives at{' '}
            <Link
              href="/monday/leads"
              className="text-[color:var(--color-accent)] hover:underline"
            >
              Monday Data
            </Link>
            .
          </p>
        </div>
        <DateRangeToggle basePath="/monday-dashboard" active={range.key} />
      </header>

      <PlaceholderPanel
        title={`Today's snapshot · ${range.label}`}
        phase={4}
        note="Items mirrored per board, sync freshness, oldest-board age. Every card clickable → drills into the item list."
      />
      <PlaceholderPanel
        title="Global performance"
        phase={4}
        note="Item-count deltas over the selected window vs the prior window. Board-by-board growth rates."
      />
      <PlaceholderPanel
        title={`Activity trend · ${range.label}`}
        phase={4}
        note="Daily new-item additions per board + mirror-sync latency over time."
      />
      <PlaceholderPanel
        title="Daily × hour heatmap"
        phase={4}
        note="When Monday items are being added vs when our nightly cron picks them up — spot sync gaps."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <PlaceholderPanel
          title="Leaderboard · Top boards"
          phase={4}
          note="Boards ranked by activity in the window. Item volume, matched S-tags, unmapped tags."
        />
        <PlaceholderPanel
          title="Leaderboard · Top brands + S-tags"
          phase={4}
          note="Brands and S-tags with the biggest recent Monday footprint — cross-check against our scrape output."
        />
      </div>
      <PlaceholderPanel
        title="Match ratios"
        phase={4}
        note="S-tag → Monday match rate over the window. Unmapped-vs-mapped trend. Mirror-group split (S-tags spanning multiple domains)."
      />
    </div>
  )
}
