import 'server-only'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type AdminCheck =
  | { ok: true; user_id: string; email: string | null }
  | { ok: false; error: string }

/**
 * Verify the caller is a signed-in admin. Reads the user from the
 * cookie-scoped Supabase client and then asks the `is_admin` RPC
 * (which checks `user_profiles.is_admin`) via the service role.
 *
 * Use from server actions that mutate via the service-role client —
 * those bypass RLS, so without this check any signed-in user could
 * call them. Return shape mirrors `requireBearer` in [./bearer.ts].
 */
export async function requireAdmin(): Promise<AdminCheck> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Admin access required.' }
  return { ok: true, user_id: user.id, email: user.email ?? null }
}
