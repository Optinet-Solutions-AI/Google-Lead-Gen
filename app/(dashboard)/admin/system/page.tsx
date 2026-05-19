import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { HitlToggle } from './_components/hitl-toggle'

export const dynamic = 'force-dynamic'

export default async function AdminSystemPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/system')

  const svc = createServiceClient()
  const { data: callerIsAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!callerIsAdmin) redirect('/')

  // Fetch the current value. The RPC returns jsonb; we coerce to a strict
  // boolean defaulting to true (the schema seeded that, but be defensive
  // against missing/legacy rows).
  const { data: hitlRaw } = await svc.rpc('get_system_setting', {
    p_key: 'hitl_enabled',
  })
  const hitlEnabled = hitlRaw === false ? false : true

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          System Settings
        </h1>
        <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
          Runtime feature flags. Changes take effect within ~5 seconds —
          workers re-read each flag at the start of every scrape job.
        </p>
      </header>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Human-in-the-loop captcha resolver
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
            When ON, scrapes that hit a captcha / age gate / cookie banner
            park in <code>needs_human</code> status and wait for an admin
            to click through via noVNC on{' '}
            <code>/admin/interactive</code>. When OFF, the same walls fail
            the job (status <code>captcha</code>) immediately so the queue
            doesn&apos;t pile up while noVNC is being set up or while an
            EU-market batch is in a rough captcha period.
          </p>
        </header>

        <HitlToggle enabled={hitlEnabled} />
      </section>
    </div>
  )
}
