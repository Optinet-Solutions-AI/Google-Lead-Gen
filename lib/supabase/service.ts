import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * Supabase service role client. Bypasses RLS.
 * SERVER-ONLY — `server-only` makes Next.js fail the build if this
 * module ends up in a client bundle.
 *
 * Fresh client per call — don't cache across requests.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
