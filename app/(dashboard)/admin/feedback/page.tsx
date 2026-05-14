import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { FeedbackList } from './_components/feedback-list'
import type { FeedbackRowData } from './_components/feedback-row'

export const dynamic = 'force-dynamic'

const STATUS_TABS = [
  { key: 'open',        label: 'Open' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'resolved',    label: 'Resolved' },
  { key: 'rejected',    label: 'Rejected' },
  { key: 'all',         label: 'All' },
] as const

type SearchParams = Record<string, string | string[] | undefined>

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/feedback')

  const svc = createServiceClient()
  const { data: callerIsAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!callerIsAdmin) redirect('/')

  const sp = await searchParams
  const statusFilter =
    typeof sp.status === 'string' && STATUS_TABS.some(t => t.key === sp.status)
      ? (sp.status as (typeof STATUS_TABS)[number]['key'])
      : 'open'

  let q = svc
    .from('qa_feedback')
    .select(
      'id, user_id, user_display, user_email, url, message, status, resolved_at, resolved_by, created_at, updated_at',
    )
    .order('created_at', { ascending: false })
    .limit(500)
  if (statusFilter !== 'all') q = q.eq('status', statusFilter)
  const { data, error } = await q
  if (error) throw error
  const rows = (data ?? []) as FeedbackRowData[]

  // Per-status counts so the tabs can show "Open · 12" etc. One small
  // extra query — cheap on this table.
  const { data: counts } = await svc
    .from('qa_feedback')
    .select('status')
  const countByStatus = new Map<string, number>()
  for (const r of (counts ?? []) as Array<{ status: string }>) {
    countByStatus.set(r.status, (countByStatus.get(r.status) ?? 0) + 1)
  }
  const totalAll = counts?.length ?? 0

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          QA Feedback
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Every message submitted via the floating widget on every
          dashboard page lands here. Update status as you triage.
        </p>
      </header>

      {/* Status tabs */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-[color:var(--color-border)]">
        {STATUS_TABS.map(tab => {
          const count =
            tab.key === 'all'
              ? totalAll
              : countByStatus.get(tab.key) ?? 0
          const active = statusFilter === tab.key
          return (
            <Link
              key={tab.key}
              href={tab.key === 'open' ? '/admin/feedback' : `/admin/feedback?status=${tab.key}`}
              className={[
                'rounded-t-md border-b-2 px-3 py-1.5 text-[12px] font-medium transition-colors',
                active
                  ? 'border-[color:var(--color-accent)] text-[color:var(--color-text-primary)]'
                  : 'border-transparent text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
              ].join(' ')}
            >
              {tab.label}
              <span
                className={[
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                  active
                    ? 'bg-[color:var(--color-accent)]/20 text-[color:var(--color-text-primary)]'
                    : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
                ].join(' ')}
              >
                {count}
              </span>
            </Link>
          )
        })}
      </nav>

      <section className="overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <FeedbackList rows={rows} />
      </section>
    </div>
  )
}
