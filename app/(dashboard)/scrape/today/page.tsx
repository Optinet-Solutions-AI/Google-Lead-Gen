import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, FlaskConical, Pencil } from 'lucide-react'
import { requireAdmin } from '@/lib/auth/require-admin'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { QuotaStatus } from '../new/_components/quota-status'
import { RemoveFromQueueButton } from './_components/remove-from-queue-button'
import { Flag } from '../../_components/flag'
import { dayLabel, engineDef, langName, utcDay, type DayUsage, type QuotaPreview } from '../new/_lib/wizard-helpers'

export const dynamic = 'force-dynamic'

const DEFAULT_CAP = 20
const DAYS_AHEAD = 7

type Row = {
  id: string
  keyword: string
  keyword_en: string | null
  country_code: string
  language: string | null
  pages: number | null
  view_mode: string | null
  with_enrichment: boolean | null
  search_engine: string | null
  status: string
  scheduled_at: string | null
  created_at: string
  started_at: string | null
  result_type_filter: string | null
  batch_group_id: string | null
  scrape_source: string | null
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-700',
  running: 'bg-blue-100 text-blue-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  captcha: 'bg-amber-100 text-amber-900',
  paused: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-zinc-100 text-zinc-600',
}

/**
 * /scrape/today — admin-only UI preview. The caller's scrapes for today
 * (UTC) plus anything scheduled ahead, grouped by day, with the quota
 * picture on top. Remove and Edit are UI-only for now.
 */
export default async function TodayScrapesPage() {
  const admin = await requireAdmin()
  if (!admin.ok) redirect('/scrape')

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const email = (user?.email ?? '').toLowerCase()
  const svc = createServiceClient()

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()

  const [capRaw, bypassRow, rows] = await Promise.all([
    svc.rpc('get_system_setting', { p_key: 'daily_scrape_cap_per_user' }).then(r => r.data as unknown),
    user
      ? svc.from('user_profiles').select('bypass_scrape_cap').eq('id', user.id).maybeSingle().then(r => r.data as { bypass_scrape_cap: boolean | null } | null)
      : Promise.resolve(null),
    email
      ? svc
          .from('scrape_queue')
          .select(
            'id, keyword, keyword_en, country_code, language, pages, view_mode, with_enrichment, search_engine, status, scheduled_at, created_at, started_at, result_type_filter, batch_group_id, scrape_source',
          )
          .eq('created_by_email', email)
          .is('parent_scrape_job_id', null)
          .or(`created_at.gte.${todayIso},scheduled_at.gte.${todayIso}`)
          .order('created_at', { ascending: false })
          .limit(500)
          .then(r => (r.data ?? []) as unknown as Row[])
      : Promise.resolve([] as Row[]),
  ])

  // Hide the auto-created Google PPC sibling; the UI treats the pair as one batch.
  const visible = rows.filter(r => !(r.result_type_filter === 'PPC' && r.batch_group_id && r.scrape_source === 'vm'))

  const capNum = typeof capRaw === 'number' ? capRaw : typeof capRaw === 'string' ? Number(capRaw) : DEFAULT_CAP
  const cap = Number.isFinite(capNum) && capNum > 0 ? Math.floor(capNum) : null
  const exempt = bypassRow?.bypass_scrape_cap === true

  const byDay = new Map<string, Row[]>()
  const usedByDay = new Map<string, Set<string>>()
  for (const r of rows) {
    const when = r.scheduled_at ?? r.created_at
    if (when < todayIso) continue
    const day = utcDay(when)
    const set = usedByDay.get(day) ?? new Set<string>()
    set.add(`${r.keyword.toLowerCase()}|${r.country_code}`)
    usedByDay.set(day, set)
  }
  for (const r of visible) {
    const when = r.scheduled_at ?? r.created_at
    if (when < todayIso) continue
    const day = utcDay(when)
    byDay.set(day, [...(byDay.get(day) ?? []), r])
  }
  const days: DayUsage[] = []
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const day = utcDay(new Date(todayStart.getTime() + i * 86_400_000))
    days.push({ day, used: usedByDay.get(day)?.size ?? 0 })
  }
  for (const [day, set] of usedByDay) if (!days.some(x => x.day === day)) days.push({ day, used: set.size })
  days.sort((a, b) => a.day.localeCompare(b.day))
  const quota: QuotaPreview = { cap, exempt, days }

  const dayKeys = [...byDay.keys()].sort()
  if (!dayKeys.includes(utcDay(todayStart))) dayKeys.unshift(utcDay(todayStart))

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-accent)]/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-primary)]">
            <FlaskConical className="h-3 w-3" /> On development
          </div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">My scraping list</h1>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
            Everything you queued for today and the days ahead. Queued items that have not started can be removed or edited.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <QuotaStatus quota={quota} variant="full" />
          <Link href="/scrape/new" className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-text-primary)] px-3 py-1.5 text-[12px] font-medium text-white">
            New scrape
          </Link>
        </div>
      </div>

      {dayKeys.map(day => {
        const list = byDay.get(day) ?? []
        return (
          <section key={day} className="flex flex-col gap-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]/80">
              {dayLabel(day)} <span className="font-normal normal-case tracking-normal">· {list.length} scrape{list.length === 1 ? '' : 's'}</span>
            </h2>
            {list.length === 0 ? (
              <p className="rounded-md border border-dashed border-[color:var(--color-border)] px-3 py-4 text-center text-[12px] text-[color:var(--color-text-secondary)]">
                Nothing queued for {dayLabel(day).toLowerCase()}.
              </p>
            ) : (
              <>
                {/* Table on tablet and desktop */}
                <div className="hidden overflow-x-auto rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] md:block">
                  <table className="w-full min-w-[720px] text-[12px]">
                    <thead>
                      <tr className="border-b border-[color:var(--color-border)] text-left text-[10px] uppercase tracking-wider text-[color:var(--color-text-secondary)]">
                        <th className="px-3 py-2 font-semibold">Keyword</th>
                        <th className="px-3 py-2 font-semibold">Source</th>
                        <th className="px-3 py-2 font-semibold">Country</th>
                        <th className="px-3 py-2 font-semibold">Setup</th>
                        <th className="px-3 py-2 font-semibold">Status</th>
                        <th className="px-3 py-2 font-semibold">When</th>
                        <th className="px-3 py-2 text-right font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map(r => (
                        <tr key={r.id} className="border-b border-[color:var(--color-border)] last:border-0">
                          <td className="px-3 py-2">
                            <div className="font-medium text-[color:var(--color-text-primary)]">{r.keyword}</div>
                            {r.keyword_en && r.keyword_en !== r.keyword && <div className="text-[11px] text-[color:var(--color-text-secondary)]">{r.keyword_en}</div>}
                          </td>
                          <td className="px-3 py-2">{engineDef(r.search_engine)?.label ?? r.search_engine ?? 'Google'}</td>
                          <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><Flag code={r.country_code} />{r.country_code}</span></td>
                          <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">{setupLabel(r)}</td>
                          <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                          <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">{whenLabel(r)}</td>
                          <td className="px-3 py-2">
                            <RowActions row={r} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Cards on phones */}
                <ul className="flex flex-col gap-2 md:hidden">
                  {list.map(r => (
                    <li key={r.id} className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[color:var(--color-text-primary)]">{r.keyword}</div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--color-text-secondary)]">
                            <span>{engineDef(r.search_engine)?.label ?? 'Google'}</span>
                            <span className="inline-flex items-center gap-1.5"><Flag code={r.country_code} />{r.country_code}</span>
                            <span>{setupLabel(r)}</span>
                          </div>
                        </div>
                        <StatusPill status={r.status} />
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-text-secondary)]">
                        <span>{whenLabel(r)}</span>
                        <RowActions row={r} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )
      })}

      <Link href="/scrape" className="inline-flex w-fit items-center gap-1.5 text-[12px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Scrape
      </Link>
    </div>
  )
}

function setupLabel(r: Row): string {
  const parts = [
    r.language ? langName(r.language) : null,
    r.pages ? `${r.pages}p` : null,
    r.view_mode && r.view_mode !== 'both' ? r.view_mode : null,
    r.with_enrichment ? 'enrich' : 'no enrich',
  ].filter(Boolean)
  return parts.join(' · ')
}

function whenLabel(r: Row): string {
  if (r.scheduled_at && r.status === 'pending' && new Date(r.scheduled_at).getTime() > Date.now()) {
    return `Scheduled ${new Date(r.scheduled_at).toLocaleString()}`
  }
  if (r.started_at) return `Started ${new Date(r.started_at).toLocaleTimeString()}`
  return `Queued ${new Date(r.created_at).toLocaleTimeString()}`
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[status] ?? 'bg-slate-100 text-slate-700'}`}>{status}</span>
  )
}

function RowActions({ row }: { row: Row }) {
  const editable = row.status === 'pending' && !row.started_at
  if (!editable) return <span className="text-[11px] text-[color:var(--color-text-secondary)]">—</span>
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Link
        href={`/scrape/new?from=${row.id}`}
        className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-2 py-1 text-[11px] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
        title="Open this scrape's setup in the wizard"
      >
        <Pencil className="h-3 w-3" /> Edit
      </Link>
      <RemoveFromQueueButton jobId={row.id} keyword={row.keyword} />
    </div>
  )
}
