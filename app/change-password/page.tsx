import { redirect } from 'next/navigation'
import { KeyRound } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { SetPasswordForm } from './_components/set-password-form'

export const dynamic = 'force-dynamic'

/**
 * The gate a new account lands on.
 *
 * An admin issues a temporary password, which necessarily travels through
 * chat or email and is read by whoever is standing nearby. It is a way in,
 * not a credential — so the account cannot reach anything else until it has
 * been replaced. The proxy sends every other path here while the flag is set.
 *
 * Lives outside the dashboard group on purpose: no sidebar, no navigation,
 * nothing to click except the form.
 */
export default async function ChangePasswordPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Already done — nothing to force. Someone reaching the URL directly goes
  // to /account/password, which is the normal way to change it later.
  if (user.app_metadata?.must_change_password !== true) redirect('/account/password')

  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--color-bg-secondary)] px-4 py-10">
      <div className="w-full max-w-sm rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-[color:var(--color-text-secondary)]" />
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Choose a password
          </h1>
        </div>
        <p className="mt-1 text-[12px] text-[color:var(--color-text-secondary)]">
          You signed in with a temporary password. Pick your own before carrying on — it is only
          known to you from here.
        </p>
        <p className="mt-2 text-[11px] text-[color:var(--color-text-secondary)]">
          Signed in as{' '}
          <span className="font-medium text-[color:var(--color-text-primary)]">{user.email}</span>
        </p>

        <SetPasswordForm />
      </div>
    </div>
  )
}
