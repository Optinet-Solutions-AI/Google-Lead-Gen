import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Cookie-aware Supabase client for Server Components, Server Actions,
 * and Route Handlers. Reads the session from cookies so
 * `supabase.auth.getUser()` works correctly after login.
 *
 * Use `createServiceClient` (sibling file) for administrative work that
 * must bypass RLS.
 */
export async function createClient() {
  const cookieStore = await cookies()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // `cookies()` is read-only in a Server Component; the middleware
          // refreshes the session on the next request so this is safe.
        }
      },
    },
  })
}
