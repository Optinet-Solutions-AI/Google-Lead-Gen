import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { AddUserForm } from './_components/add-user-form'
import { UserListRow } from './_components/user-list-row'

export const dynamic = 'force-dynamic'

type AuthUser = {
  id: string
  username: string | null
  display_name: string | null
  created_at: string
  last_sign_in_at: string | null
}

type ProfileRow = {
  id: string
  username: string | null
  display_name: string | null
  is_admin: boolean
  is_shadow: boolean
  monday_user_id: number | null
}

export default async function AdminUsersPage() {
  // Gate: only admins reach this page.
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/users')

  const svc = createServiceClient()
  const { data: callerIsAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!callerIsAdmin) redirect('/')
  const { data: callerIsShadow } = await svc.rpc('is_shadow_user', { p_user_id: user.id })
  const viewerIsShadow = callerIsShadow === true

  // Pull every profile + every auth.users row, then merge by id. We
  // don't surface the synthetic email anywhere — the UI is purely
  // username + display_name driven.
  const [{ data: usersPage }, { data: profiles }] = await Promise.all([
    svc.auth.admin.listUsers({ page: 1, perPage: 200 }),
    svc.from('user_profiles').select('id, username, display_name, is_admin, is_shadow, monday_user_id'),
  ])

  const profileById = new Map<string, ProfileRow>(
    ((profiles ?? []) as ProfileRow[]).map(p => [p.id, p]),
  )

  // Shadow accounts are invisible to non-shadow viewers and shadow
  // viewers only see themselves (siloed across multiple shadows).
  const users: AuthUser[] = (usersPage?.users ?? [])
    .filter(u => {
      const p = profileById.get(u.id)
      const targetIsShadow = p?.is_shadow === true
      if (viewerIsShadow) return u.id === user.id
      return !targetIsShadow
    })
    .map(u => {
      const p = profileById.get(u.id) ?? null
      return {
        id: u.id,
        username: p?.username ?? null,
        display_name: p?.display_name ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
      }
    })
  users.sort((a, b) =>
    (a.display_name || a.username || '').localeCompare(b.display_name || b.username || ''),
  )

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Users
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Add new sign-ins, promote / demote admins. Every action a user takes
          (queue a scrape, override a flag, push to Monday, …) is recorded with
          their email in <code>activity_log</code> and on each created row.
        </p>
      </header>

      <AddUserForm />

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <header className="border-b border-[color:var(--color-border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Existing users · {users.length}
        </header>
        <div className="divide-y divide-[color:var(--color-border)]">
          {users.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-[color:var(--color-text-secondary)]">
              No users yet.
            </p>
          )}
          {users.map(u => (
            <UserListRow
              key={u.id}
              user={u}
              isAdmin={profileById.get(u.id)?.is_admin ?? false}
              isSelf={u.id === user.id}
              mondayUserId={profileById.get(u.id)?.monday_user_id ?? null}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
