import { redirect } from 'next/navigation'
import { ArrowUpRight, FileBarChart } from 'lucide-react'
import { requireAdmin } from '@/lib/auth/require-admin'
import { REPORTS, type ReportMetric } from './_lib/reports'

export const dynamic = 'force-dynamic'

/**
 * /admin/reports — measurement reports. Each one answered a question with
 * real numbers; the headline figures are here and the full interactive
 * report opens in a new tab.
 */
export default async function AdminReportsPage() {
  const admin = await requireAdmin()
  if (!admin.ok) redirect('/')

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">Measurement reports</h1>
        <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
          Experiments run against real data, with the numbers that came out of them. Open a report for the per-site detail,
          filters and raw payloads.
        </p>
      </header>

      {REPORTS.length === 0 ? (
        <p className="rounded-md border border-dashed border-[color:var(--color-border)] px-3 py-6 text-center text-[12px] text-[color:var(--color-text-secondary)]">
          No measurement reports yet.
        </p>
      ) : (
        REPORTS.map(r => (
          <section key={r.slug} className="flex flex-col gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-[14px] font-semibold text-[color:var(--color-text-primary)]">
                  <FileBarChart className="h-4 w-4 shrink-0 text-[color:var(--color-text-secondary)]" />
                  {r.title}
                </h2>
                <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
                  {r.question}
                </p>
                <p className="mt-1 max-w-3xl text-[13px] text-[color:var(--color-text-primary)]">{r.finding}</p>
                <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
                  Run {new Date(r.ranOn).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · {r.sample}
                </p>
              </div>
              <a
                href={r.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[color:var(--color-text-primary)] px-3 py-2 text-[12px] font-medium text-white hover:opacity-90"
              >
                Open report <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </header>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {r.metrics.map(m => (
                <Metric key={m.label} metric={m} />
              ))}
            </div>

            {r.actions.length > 0 && (
              <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
                  What it points to
                </div>
                <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[12px] text-[color:var(--color-text-secondary)]">
                  {r.actions.map(a => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))
      )}
    </div>
  )
}

function Metric({ metric }: { metric: ReportMetric }) {
  const tone =
    metric.tone === 'ok'
      ? 'text-emerald-700'
      : metric.tone === 'warn'
        ? 'text-amber-700'
        : metric.tone === 'bad'
          ? 'text-red-700'
          : 'text-[color:var(--color-text-primary)]'
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="text-[11px] text-[color:var(--color-text-secondary)]">{metric.label}</div>
      <div className={`text-[17px] font-semibold tabular-nums ${tone}`}>{metric.value}</div>
      {metric.note && <div className="mt-0.5 text-[10px] leading-snug text-[color:var(--color-text-secondary)]">{metric.note}</div>}
    </div>
  )
}
