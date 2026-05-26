import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Construction } from 'lucide-react'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

// Bounce admins straight back into the app — the notice is for everyone
// else. If maintenance is toggled OFF and a non-admin somehow lands here,
// also redirect so the page doesn't become a sticky dead-end.
export default async function MaintenancePage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const svc = createServiceClient()
  const { data: maintRaw } = await svc.rpc('get_system_setting', {
    p_key: 'maintenance_mode',
  })
  const maintenanceEnabled = maintRaw === true
  if (!maintenanceEnabled) redirect('/')

  if (user?.id) {
    const { data: isAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
    if (isAdmin) redirect('/')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--color-bg-secondary)] px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <Construction className="h-5 w-5" />
          </span>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Temporarily unavailable
          </h1>
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-[color:var(--color-text-primary)]">
          Hi Everyone, we are doing major revisions in the backend today
          and the lead gen tool will be temporarily unavailable. Sorry for
          the inconvenience.
        </p>

        <p className="mt-4 text-[11px] text-[color:var(--color-text-secondary)]">
          Try again later. If you need urgent access, message an admin.
        </p>

        <div className="mt-6">
          <Link
            href="/login"
            className="text-[12px] font-medium text-[color:var(--color-accent)] hover:underline"
          >
            Back to sign-in
          </Link>
        </div>
      </div>
    </div>
  )
}
