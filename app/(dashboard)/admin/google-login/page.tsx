import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CredentialRow } from './_components/credential-row'

export const dynamic = 'force-dynamic'

type Country = {
  country_code: string
  country_name: string
  requires_google_login: boolean
  is_google_logged_in: boolean
}

type Credential = {
  id: string
  country_code: string
  email: string
  is_active: boolean
  last_used_at: string | null
  last_used_status: string | null
  notes: string | null
  updated_at: string
}

export default async function AdminGoogleLoginPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/google-login')

  const svc = createServiceClient()
  const { data: callerIsAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!callerIsAdmin) redirect('/')

  const [{ data: profilesRows }, { data: credsRows }] = await Promise.all([
    svc
      .from('gologin_profiles')
      .select('country_code, country_name, requires_google_login, is_google_logged_in')
      .eq('is_active', true)
      .order('country_name', { ascending: true }),
    svc
      .from('google_login_credentials')
      .select('id, country_code, email, is_active, last_used_at, last_used_status, notes, updated_at')
      .eq('is_active', true),
  ])

  const profiles = (profilesRows ?? []) as Country[]
  const credsByCountry = new Map<string, Credential>()
  for (const c of (credsRows ?? []) as Credential[]) {
    credsByCountry.set(c.country_code, c)
  }

  // Two buckets: countries flagged requires_google_login (the ones that
  // matter), then everything else underneath. Operators see the
  // important rows first.
  const required = profiles.filter(p => p.requires_google_login)
  const optional = profiles.filter(p => !p.requires_google_login)

  const requiredWithCreds = required.filter(p => credsByCountry.has(p.country_code)).length

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Google Login Credentials
        </h1>
        <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
          Per-country Google account credentials. The scraper auto-logs in
          when a profile is detected as logged-out (rotating IPs invalidate
          Google sessions), and falls back to the Captcha helper
          if Google throws 2FA / verify-it&apos;s-you. Passwords are encrypted
          via Supabase Vault — only the scraper&apos;s service role can
          decrypt them, and admins never see them after save.
        </p>
        <p className="mt-2 max-w-3xl text-[11px] text-amber-700">
          ⚠ Use throwaway Google accounts dedicated to scraping, never personal
          or business ones. Google will lock these accounts eventually — that&apos;s
          expected.
        </p>
      </header>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          <span>Countries that require Google login · {required.length}</span>
          <span className="font-normal normal-case tracking-normal">
            {requiredWithCreds}/{required.length} configured
          </span>
        </header>
        <div className="divide-y divide-[color:var(--color-border)]">
          {required.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-[color:var(--color-text-secondary)]">
              No countries flagged as requires_google_login. Toggle the flag
              on a country in <code>/profiles</code>.
            </p>
          )}
          {required.map(p => (
            <CredentialRow
              key={p.country_code}
              country={p}
              credential={credsByCountry.get(p.country_code) ?? null}
            />
          ))}
        </div>
      </section>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          <span>Other countries · {optional.length}</span>
          <span className="font-normal normal-case tracking-normal">
            credentials optional
          </span>
        </header>
        <div className="divide-y divide-[color:var(--color-border)]">
          {optional.map(p => (
            <CredentialRow
              key={p.country_code}
              country={p}
              credential={credsByCountry.get(p.country_code) ?? null}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
