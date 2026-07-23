import 'server-only'
import Link from 'next/link'
import { Hand } from 'lucide-react'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * "N of YOUR scrapes waiting for human" banner. Renders on every
 * dashboard page when at least one interactive_checkpoint is in
 * status='waiting' AND is on a scrape job the current user queued.
 *
 * Per-user scoping matches the /admin/interactive default view — a
 * banner counting the entire fleet's backlog when only one user's
 * batch is stuck was reading as a system-wide anxiety inducer.
 * The Interactive page itself has a "Show all users" toggle for
 * operators who want to help others.
 */
export async function InteractiveBanner() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const svc = createServiceClient()
  const viewerEmail = (user.email ?? '').toLowerCase()

  // Count only waiting checkpoints on this user's own jobs, and drop
  // past-expiry rows (dead sessions the worker gave up on) so the
  // banner never lies.
  const { data: ownJobs } = await svc
    .from('scrape_queue')
    .select('id')
    .eq('created_by_email', viewerEmail || '__no_email__')
  const ownJobIds = ((ownJobs ?? []) as Array<{ id: string }>).map(j => j.id)
  if (ownJobIds.length === 0) return null

  const nowIso = new Date().toISOString()
  const { count } = await svc
    .from('interactive_checkpoints')
    .select('id', { head: true, count: 'exact' })
    .eq('status', 'waiting')
    .gt('expires_at', nowIso)
    .in('job_id', ownJobIds.slice(0, 500))
  if (!count || count <= 0) return null

  // Intentionally NOT sticky. A `sticky top-0 z-30` banner sits at the
  // viewport top and visually hides the tables' own `sticky top-0 z-20`
  // header cells whenever it's showing — operators with a backlog of
  // captchas (i.e. the common case) lose the column headers as soon as
  // they scroll past row ~10. Letting this banner scroll with the page
  // keeps it visible on first paint, surfaces persistently via the
  // sidebar bandwidth meter + /admin/interactive nav, and stops fighting
  // every table on the dashboard for the top-of-viewport slot.
  return (
    <Link
      href="/admin/interactive"
      className="block border-b border-amber-300 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 hover:bg-amber-100"
    >
      <span className="inline-flex items-center gap-2">
        <Hand className="h-4 w-4 shrink-0" />
        <strong>{count}</strong> of your captcha{count === 1 ? '' : 's'} 2Captcha
        couldn&apos;t auto-solve — {count === 1 ? 'needs' : 'need'} a human. Click to resolve.
      </span>
    </Link>
  )
}
