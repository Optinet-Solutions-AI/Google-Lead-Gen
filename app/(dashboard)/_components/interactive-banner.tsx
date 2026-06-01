import 'server-only'
import Link from 'next/link'
import { Hand } from 'lucide-react'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Global "N scrapes waiting for human" banner. Renders on every
 * dashboard page when at least one interactive_checkpoint is in
 * status='waiting'. Click → /admin/interactive.
 *
 * Visible to any signed-in user — the /admin/interactive page lets
 * anyone resolve captchas, so the banner should too.
 */
export async function InteractiveBanner() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const svc = createServiceClient()
  const { count } = await svc
    .from('interactive_checkpoints')
    .select('id', { head: true, count: 'exact' })
    .eq('status', 'waiting')
  if (!count || count <= 0) return null

  return (
    <Link
      href="/admin/interactive"
      className="sticky top-0 z-30 block border-b border-amber-300 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 hover:bg-amber-100"
    >
      <span className="inline-flex items-center gap-2">
        <Hand className="h-4 w-4 shrink-0" />
        <strong>{count}</strong> captcha{count === 1 ? '' : 's'} 2Captcha
        couldn&apos;t auto-solve — {count === 1 ? 'needs' : 'need'} a human. Click to resolve.
      </span>
    </Link>
  )
}
