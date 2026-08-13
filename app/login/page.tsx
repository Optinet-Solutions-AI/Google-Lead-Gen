import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LoginForm } from './_components/login-form'

type Props = {
  searchParams: Promise<{ from?: string; reason?: string }>
}

function safeFrom(from: string | undefined): string {
  if (!from || /[\r\n\\]/.test(from)) return '/monday/leads'
  return from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login')
    ? from
    : '/monday/leads'
}

export default async function LoginPage({ searchParams }: Props) {
  const sp = await searchParams
  const sessionExpired = sp.reason === 'session_expired'

  // If the visitor still has a valid session — e.g. the proxy bounced them here
  // on a transient network blip that (correctly) did NOT wipe their cookies —
  // send them straight back in instead of making them sign in again. getUser()
  // is wrapped so that if the network is still settling it just shows the form.
  let alreadyAuthed = false
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    alreadyAuthed = user !== null
  } catch {
    // Auth server unreachable right now — fall through to the sign-in form.
  }
  if (alreadyAuthed) redirect(safeFrom(sp.from))
  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--color-bg-secondary)] px-4 py-10">
      <div className="w-full max-w-sm rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Sign in
        </h1>
        <p className="mt-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Rooster Partners internal dashboard.
        </p>
        {sessionExpired && (
          <div
            role="status"
            className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
          >
            Your session expired. Please sign in again.
          </div>
        )}
        <div className="mt-4">
          <LoginForm redirectTo={sp.from ?? ''} />
        </div>
      </div>
    </div>
  )
}
