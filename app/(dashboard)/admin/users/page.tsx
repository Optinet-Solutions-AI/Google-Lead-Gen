import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { AddUserForm } from './_components/add-user-form'
import { UserListRow } from './_components/user-list-row'

export const dynamic = 'force-dynamic'

type AuthUser = {
  id: string
  email: string | null
  created_at: string
  last_sign_in_at: string | null
}

type ProfileRow = {
  id: string
  is_admin: boolean
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

  // List all users via the admin API + their profile flags.
  const [{ data: usersPage }, { data: profiles }] = await Promise.all([
    svc.auth.admin.listUsers({ page: 1, perPage: 200 }),
    svc.from('user_profiles').select('id, is_admin'),
  ])

  const profileById = new Map<string, boolean>(
    ((profiles ?? []) as ProfileRow[]).map(p => [p.id, p.is_admin]),
  )

  const users: AuthUser[] = (usersPage?.users ?? []).map(u => ({
    id: u.id,
    email: u.email ?? null,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
  }))
  users.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''))

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
              isAdmin={profileById.get(u.id) ?? false}
              isSelf={u.id === user.id}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
