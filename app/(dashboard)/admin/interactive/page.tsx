import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { buildSignedVncUrl } from '@/lib/interactive/signed-vnc-url'
import { CheckpointCard } from './_components/checkpoint-card'
import { HideTimersToggle, TimerPrefsProvider } from './_components/timer-prefs'

export const dynamic = 'force-dynamic'

const STATUS_TABS = [
  { key: 'waiting',   label: 'Waiting' },
  { key: 'resolved',  label: 'Resolved' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'timed_out', label: 'Timed out' },
  { key: 'all',       label: 'All' },
] as const

type SearchParams = Record<string, string | string[] | undefined>

type CheckpointRow = {
  id: number
  job_id: string
  worker_id: string
  worker_port: number
  reason: string
  current_url: string | null
  page_title: string | null
  screenshot_path: string | null
  status: 'waiting' | 'resolved' | 'cancelled' | 'timed_out'
  resolution_note: string | null
  resolved_at: string | null
  resolved_by: string | null
  expires_at: string
  created_at: string
  updated_at: string
  // Claim state — set when a user clicks Open VNC. Auto-expires after
  // 8 minutes if no Resume / Cancel.
  claimed_by_user_id: string | null
  claimed_by_display: string | null
  claimed_at: string | null
  claim_expires_at: string | null
  // Per-checkpoint VM ingress host. NULL falls back to NEXT_PUBLIC_VNC_BASE_URL.
  vnc_host: string | null
}

export default async function InteractiveCheckpointsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/interactive')

  const svc = createServiceClient()
  // No admin gate — any signed-in user can resolve captchas. Bottlenecking
  // the Captcha solver on a single admin defeats the point. The URL keeps
  // the /admin/ prefix for backwards-compatibility; rename to /interactive
  // in a future cleanup if it bothers anyone.

  const sp = await searchParams
  const filter =
    typeof sp.status === 'string' && STATUS_TABS.some(t => t.key === sp.status)
      ? (sp.status as (typeof STATUS_TABS)[number]['key'])
      : 'waiting'

  let q = svc
    .from('interactive_checkpoints')
    .select(
      'id, job_id, worker_id, worker_port, reason, current_url, page_title, screenshot_path, status, resolution_note, resolved_at, resolved_by, expires_at, created_at, updated_at, claimed_by_user_id, claimed_by_display, claimed_at, claim_expires_at, vnc_host',
    )
    .order('created_at', { ascending: false })
    .limit(200)
  if (filter !== 'all') q = q.eq('status', filter)

  const [{ data: rowsData, error }, { data: counts }] = await Promise.all([
    q,
    svc.from('interactive_checkpoints').select('status'),
  ])
  if (error) throw error
  const rows = (rowsData ?? []) as CheckpointRow[]
  const countByStatus = new Map<string, number>()
  for (const r of (counts ?? []) as Array<{ status: string }>) {
    countByStatus.set(r.status, (countByStatus.get(r.status) ?? 0) + 1)
  }
  const totalAll = counts?.length ?? 0

  // Pull the requester per job — operators on the Captcha solver page
  // need to know whose scrape they're solving, especially when multiple
  // users have queued work at the same time. `created_by_*` is
  // denormalized on scrape_queue at enqueue time, so this is a single
  // id-list lookup.
  const jobIds = Array.from(new Set(rows.map(r => r.job_id)))
  const requesterByJobId = new Map<
    string,
    { display: string | null; username: string | null; keyword: string | null }
  >()
  if (jobIds.length > 0) {
    const { data: jobRows } = await svc
      .from('scrape_queue')
      .select('id, keyword, created_by_display, created_by_username')
      .in('id', jobIds)
    for (const j of (jobRows ?? []) as Array<{
      id: string
      keyword: string | null
      created_by_display: string | null
      created_by_username: string | null
    }>) {
      requesterByJobId.set(j.id, {
        display: j.created_by_display,
        username: j.created_by_username,
        keyword: j.keyword,
      })
    }
  }

  // Pre-sign noVNC URLs + screenshot URLs for waiting rows so the
  // operator can click straight through. Resolved/cancelled rows
  // don't need a live VNC link — the session is gone.
  //
  // The pre-signed URL is only ever shown to operators who already hold
  // the claim. Open-VNC click flow goes through openVncAction which
  // performs the claim atomically and returns the signed URL. We still
  // generate it server-side here so the card can show "Re-open VNC"
  // immediately for the holder without an extra round trip.
  const liveCards = await Promise.all(
    rows.map(async row => {
      let vncUrl: string | null = null
      if (row.status === 'waiting') {
        vncUrl = await buildSignedVncUrl({
          workerPort: row.worker_port,
          hostBase: row.vnc_host,
        })
      }
      let screenshotUrl: string | null = null
      if (row.screenshot_path) {
        const { data: signed } = await svc.storage
          .from('lead-screenshots')
          .createSignedUrl(row.screenshot_path, 60 * 60)
        screenshotUrl = signed?.signedUrl ?? null
      }
      const requester = requesterByJobId.get(row.job_id) ?? null
      return { row, vncUrl, screenshotUrl, requester }
    }),
  )

  const vncBaseUrl = process.env.NEXT_PUBLIC_VNC_BASE_URL ?? null
  const vncSecretConfigured = Boolean(process.env.INTERACTIVE_VNC_HMAC_SECRET)

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Interactive checkpoints
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          When the scraper hits a wall it can&apos;t cross on its own
          (captcha, age verification, cookie banner) it pauses here
          and waits for a human. Click <strong>Open VNC</strong> to
          drop into the live browser, click through the wall, then
          come back and hit <strong>Resume</strong>.
        </p>
        {(!vncBaseUrl || !vncSecretConfigured) && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
            <strong>noVNC not configured.</strong> Set{' '}
            <code>NEXT_PUBLIC_VNC_BASE_URL</code> and{' '}
            <code>INTERACTIVE_VNC_HMAC_SECRET</code> on the Vercel side
            and run the matching VM-side setup
            (<code>docs/runbook-novnc.md</code>) to enable Open-VNC
            buttons. Without it, Resume / Cancel still work — operators
            would need a TightVNC client to actually click through.
          </p>
        )}
      </header>

      <nav className="flex flex-wrap items-center gap-1 border-b border-[color:var(--color-border)]">
        {STATUS_TABS.map(tab => {
          const count = tab.key === 'all' ? totalAll : countByStatus.get(tab.key) ?? 0
          const active = filter === tab.key
          return (
            <Link
              key={tab.key}
              href={
                tab.key === 'waiting'
                  ? '/admin/interactive'
                  : `/admin/interactive?status=${tab.key}`
              }
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

      <TimerPrefsProvider>
        {liveCards.length === 0 ? (
          <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-10 text-center text-[12px] text-[color:var(--color-text-secondary)]">
            {filter === 'waiting'
              ? 'No paused scrapes — workers are humming along on their own.'
              : `No checkpoints under "${filter}".`}
          </div>
        ) : (
          <>
            {filter === 'waiting' && (
              <div className="flex justify-end">
                <HideTimersToggle />
              </div>
            )}
            <div className="flex flex-col gap-3">
              {liveCards.map(card => (
                <CheckpointCard
                  key={card.row.id}
                  row={card.row}
                  vncUrl={card.vncUrl}
                  screenshotUrl={card.screenshotUrl}
                  currentUserId={user.id}
                  requester={card.requester}
                />
              ))}
            </div>
          </>
        )}
      </TimerPrefsProvider>
    </div>
  )
}
