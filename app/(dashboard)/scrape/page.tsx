import { AutoRefresh } from './_components/auto-refresh'
import { EnqueueForm } from './_components/enqueue-form'
import { JobsCardList, JobsTable } from './_components/jobs-table'
import { listActiveProfiles, listRecentJobs } from './_lib/queries'

export const dynamic = 'force-dynamic'

export default async function ScrapePage() {
  const [profiles, jobs] = await Promise.all([
    listActiveProfiles(),
    listRecentJobs(30),
  ])

  // Auto-refresh stays on while either the scrape itself OR a follow-on
  // enrichment chain is still in flight, so the badge can transition from
  // "enriching" to "completed" without a manual reload.
  const hasActive = jobs.some(
    j =>
      j.status === 'pending' ||
      j.status === 'running' ||
      (j.status === 'completed' &&
        j.with_enrichment &&
        j.enrichment_status !== 'complete'),
  )

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Scrape
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Queue a keyword for a country. A VM worker picks it up within ~5 seconds and
          the results land in the Lead Generator table once complete.
        </p>
      </header>

      <EnqueueForm profiles={profiles} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Recent jobs
          </h2>
          <p className="text-[11px] text-[color:var(--color-text-secondary)]">
            {hasActive ? 'auto-refreshing every 5 s' : 'showing last 30'}
          </p>
        </div>

        <JobsTable jobs={jobs} />
        <JobsCardList jobs={jobs} />
      </section>

      <AutoRefresh enabled={hasActive} />
    </div>
  )
}
