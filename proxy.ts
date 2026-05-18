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

  // If Supabase's auth call throws (e.g. consumed refresh token after a
  // long idle), don't let it crash the proxy — that produces a 500 +
  // "This page couldn't load" UI and the stale cookie keeps re-firing
  // on every nav until manual sign-out. Treat the throw as
  // "session expired", clear the broken sb-* cookies, and redirect to
  // /login so the user gets a clean re-auth.
  let result: Awaited<ReturnType<typeof updateSession>> | null = null
  let refreshError: unknown = null
  try {
    result = await updateSession(request)
  } catch (e) {
    refreshError = e
  }

  if (refreshError || !result?.user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('from', pathname)
    if (refreshError) {
      url.searchParams.set('reason', 'session_expired')
      console.warn('[proxy] session refresh threw — clearing auth cookies', refreshError)
    }
    const redirect = NextResponse.redirect(url)
    if (refreshError) {
      // Wipe every Supabase auth cookie so the next request to /login
      // (and the sign-in attempt itself) doesn't re-trigger the same
      // throw on the stale refresh token.
      for (const c of request.cookies.getAll()) {
        if (c.name.startsWith('sb-') && c.name.includes('-auth-token')) {
          redirect.cookies.delete(c.name)
        }
      }
    }
    return redirect
  }

  return result.response
}

export const config = {
  // Run on all routes except static assets + endpoints that authenticate themselves.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/monday/webhook|api/monday/sync|api/scheduler/tick|api/enrichment).*)',
  ],
}
