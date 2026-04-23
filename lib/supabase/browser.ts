import { createBrowserClient } from '@supabase/ssr'

/**
 * Supabase client for Client Components. Uses the public anon key and
 * reads the session from cookies automatically.
 *
 * Writes from the browser are blocked for non-admin users once RLS is
 * in place — route mutations through Server Actions that call
 * `createServiceClient()` from lib/supabase/service.ts when privileged.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')
  return createBrowserClient(url, key)
}
