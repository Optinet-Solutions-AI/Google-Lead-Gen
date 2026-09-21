import type { NextRequest } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { loadCtaLinks } from '@/app/(dashboard)/affiliates/_lib/query'

export const dynamic = 'force-dynamic'

/**
 * CTA links for one website profile, loaded on demand when a row is expanded.
 * Shipping all ~800 links with the table would be wasteful when most rows are
 * never opened.
 *
 * Auth: signed-in users only (the dashboard proxy already gates this path, but
 * the check is repeated here so the route is not open on its own).
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Not signed in.' }, { status: 401 })

  const raw = req.nextUrl.searchParams.get('profile_id')
  const profileId = Number(raw)
  if (!Number.isInteger(profileId) || profileId <= 0) {
    return Response.json({ error: 'profile_id must be a positive integer.' }, { status: 400 })
  }

  const links = await loadCtaLinks(profileId)
  return Response.json({ links })
}
