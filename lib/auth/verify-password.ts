import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * One-shot password verification using a stateless anon client.
 *
 * Why not the cookie-bound server client: supabase-ssr's server
 * client writes refreshed session cookies whenever
 * `signInWithPassword` succeeds — so a "please re-enter your
 * password" check silently rotates the caller's session JWT in the
 * response cookies. That can desync the caller's session mid-action
 * (especially when the action then fails and the partial cookie
 * state is the only thing the user is left with).
 *
 * With `persistSession: false` and `autoRefreshToken: false` the
 * supabase-js client never reads or writes cookies; the call is a
 * pure yes/no against the auth API.
 */
export async function verifyUserPassword(
  email: string,
  password: string,
): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase env missing')
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  return !error
}
