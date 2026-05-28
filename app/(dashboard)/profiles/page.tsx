import { createServiceClient } from '@/lib/supabase/service'
import { ProfileRowEditor, type ProfileRow } from './_components/profile-row'

export const dynamic = 'force-dynamic'

export default async function ProfilesPage() {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('gologin_profiles')
    .select(
      'country_code, country_name, gologin_display_name, gologin_profile_id, is_active, requires_google_login, is_google_logged_in, google_login_verified_at, google_login_notes, login_check_source, updated_at',
    )
    .order('country_name', { ascending: true })
  if (error) throw error
  const profiles = (data ?? []) as ProfileRow[]

  const total = profiles.length
  const required = profiles.filter(p => p.requires_google_login).length
  const loggedIn = profiles.filter(p => p.is_google_logged_in).length
  const needsAttention = profiles.filter(
    p => p.requires_google_login && !p.is_google_logged_in,
  ).length

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Country profiles
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Track which GoLogin country profiles have an age-verified Google account
          signed in. Some countries (Germany, Italy, etc.) gate gambling-keyword PPC
          results behind login — flag those as <em>requires login</em> and toggle
          <em> logged in</em> as you finish each one.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <Badge label={`${total} profiles`} cls="bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]" />
          <Badge label={`${required} require login`} cls="bg-amber-100 text-amber-800" />
          <Badge label={`${loggedIn} logged in`} cls="bg-emerald-100 text-emerald-800" />
          {needsAttention > 0 && (
            <Badge label={`${needsAttention} need attention`} cls="bg-rose-100 text-rose-800" />
          )}
        </div>
      </header>

      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-[color:var(--color-border-strong)]">
            <tr>
              <Th>Country</Th>
              <Th>GoLogin profile</Th>
              <Th>Requires login?</Th>
              <Th>Logged in?</Th>
              <Th>Verified at</Th>
              <Th>Notes</Th>
            </tr>
          </thead>
          <tbody>
            {profiles.map(p => (
              <ProfileRowEditor key={p.country_code} profile={p} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={['inline-block rounded-full px-2.5 py-0.5 text-[10px] font-medium', cls].join(' ')}>
      {label}
    </span>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="sticky top-0 z-20 whitespace-nowrap border-b border-[color:var(--color-border-strong)] bg-[color:var(--color-border-strong)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]"
    >
      {children}
    </th>
  )
}
