import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { generateTemporaryPassword } from '../../lib/auth/password-policy'

/**
 * Create or re-issue accounts with a one-time password.
 *
 * Every account gets its own password from a CSPRNG — never a shared one,
 * which is the usual shortcut and means the first person to receive it can
 * sign in as any of the others. Each is flagged `must_change_password` in
 * app_metadata, which the proxy enforces and only the service role can clear.
 *
 * Existing accounts are re-issued rather than duplicated: the password is
 * reset, the admin flag applied, and the gate re-armed.
 *
 *   npx tsx scripts/admin/provision-users.ts            # dry run
 *   npx tsx scripts/admin/provision-users.ts --apply
 */

type Spec = { email: string; username: string; isAdmin: boolean }

const USERS: Spec[] = [
  // Operators.
  { email: 'ma@onwardmessage.com', username: 'ma', isAdmin: false },
  { email: 'ah@onwardmessage.com', username: 'ah', isAdmin: false },
  { email: 'au@onwardmessage.com', username: 'au', isAdmin: false },
  { email: 'ci@onwardmessage.com', username: 'ci', isAdmin: false },
  { email: 'da@onwardmessage.com', username: 'da', isAdmin: false },
  { email: 'gd@onwardmessage.com', username: 'gd', isAdmin: false },
  { email: 'rn@onwardmessage.com', username: 'rn', isAdmin: false },
  // Admins.
  { email: 'chris@optinetsolutions.com', username: 'chris', isAdmin: true },
  { email: 'ivan@optinetsolutions.com', username: 'ivan', isAdmin: true },
  { email: 'jose@optinetsolutions.com', username: 'jose', isAdmin: true },
]

async function main() {
  const apply = process.argv.includes('--apply')
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // One listing instead of a lookup per user.
  const existing = new Map<string, string>()
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    for (const u of data.users) if (u.email) existing.set(u.email.toLowerCase(), u.id)
    if (data.users.length < 200) break
  }

  const results: Array<{ email: string; username: string; role: string; action: string; password: string }> = []

  for (const spec of USERS) {
    const found = existing.get(spec.email.toLowerCase())
    const password = generateTemporaryPassword()
    const role = spec.isAdmin ? 'admin' : 'user'

    if (!apply) {
      results.push({ ...spec, role, action: found ? 'reset (exists)' : 'create', password: '(dry run)' })
      continue
    }

    let userId = found
    if (userId) {
      const { error } = await svc.auth.admin.updateUserById(userId, {
        password,
        app_metadata: { must_change_password: true },
      })
      if (error) throw new Error(`${spec.email}: ${error.message}`)
    } else {
      const { data, error } = await svc.auth.admin.createUser({
        email: spec.email,
        password,
        email_confirm: true,
        app_metadata: { must_change_password: true },
      })
      if (error) throw new Error(`${spec.email}: ${error.message}`)
      userId = data.user!.id
    }

    // The on_auth_user_created trigger makes the profile row; set the parts
    // it cannot know. display_name is left for an admin to fill in — these
    // are initials, and guessing whose would put a wrong name on an account.
    const { error: pErr } = await svc
      .from('user_profiles')
      .update({ username: spec.username, is_admin: spec.isAdmin, updated_at: new Date().toISOString() })
      .eq('id', userId)
    if (pErr) throw new Error(`${spec.email} profile: ${pErr.message}`)

    results.push({ ...spec, role, action: found ? 'reset' : 'created', password })
  }

  console.table(results.map(r => ({ email: r.email, username: r.username, role: r.role, action: r.action, 'temporary password': r.password })))
  if (!apply) console.log('\nDry run — nothing was written. Re-run with --apply.')
}

main().catch(e => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
