import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * Protects every route except:
 *   /login                  — the sign-in page itself
 *   /api/monday/webhook     — Monday authenticates via HS256 JWT, not Supabase
 *   /api/monday/sync        — Vercel cron authenticates via Bearer CRON_SECRET
 *   /api/scheduler/tick     — Vercel cron authenticates via Bearer CRON_SECRET
 *   static assets           — handled by the `matcher` below
 *
 * Unauthenticated users on a protected route are redirected to /login
 * with ?from=<original-path> so the login page can bounce them back.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Never gate the webhook, the scheduler cron, the Monday nightly re-sync
  // cron, the internal enrichment endpoint (auth'd via INTERNAL_API_TOKEN),
  // or the login page itself.
  if (
    pathname.startsWith('/api/monday/webhook') ||
    pathname.startsWith('/api/monday/sync') ||
    pathname.startsWith('/api/scheduler/tick') ||
    pathname.startsWith('/api/enrichment/') ||
    pathname.startsWith('/login')
  ) {
    return NextResponse.next()
  }

  const { response, user } = await updateSession(request)

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('from', pathname)
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  // Run on all routes except static assets + endpoints that authenticate themselves.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/monday/webhook|api/monday/sync|api/scheduler/tick|api/enrichment).*)',
  ],
}
