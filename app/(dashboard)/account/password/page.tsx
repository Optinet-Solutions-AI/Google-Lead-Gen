import { createClient } from '@/lib/supabase/server'
import { ChangePasswordForm } from './_components/change-password-form'

export default async function ChangePasswordPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const emailLocalPart = user?.email?.split('@')[0] ?? 'user'

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Change password
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Signed in as <span className="text-[color:var(--color-text-primary)]">{emailLocalPart}</span>
        </p>
      </header>

      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <ChangePasswordForm />
      </div>
    </div>
  )
}
