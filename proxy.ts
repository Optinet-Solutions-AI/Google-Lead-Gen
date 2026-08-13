import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * Protects every route except:
 *   /login                  — the sign-in page itself
 *   /auth/portal-callback   — cross-dashboard SSO landing; authenticates via a
 *                             portal-signed JWT and CREATES the session, so it
 *                             necessarily arrives without one
 *   /api/monday/webhook     — Monday authenticates via HS256 JWT, not Supabase
 *   /api/monday/sync        — Vercel cron authenticates via Bearer CRON_SECRET
 *   /api/scheduler/tick     — Vercel cron authenticates via Bearer CRON_SECRET
 *   /api/proxy/bandwidth/refresh — Vercel cron authenticates via Bearer CRON_SECRET
 *   static assets           — handled by the `matcher` below
 *
 * Unauthenticated users on a protected route are redirected to /login
 * with ?from=<original-path> so the login page can bounce them back.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Never gate the webhook, the scheduler cron, the Monday nightly re-sync
  // cron, the internal enrichment endpoint (auth'd via INTERNAL_API_TOKEN),
  // the SSO callback (verifies a portal-signed JWT and mints the session
  // itself — gating it would redirect the token away before it's read), or
  // the login page itself.
  if (
    pathname.startsWith('/auth/portal-callback') ||
    pathname.startsWith('/api/monday/webhook') ||
    pathname.startsWith('/api/monday/sync') ||
    pathname.startsWith('/api/scheduler/tick') ||
    pathname.startsWith('/api/proxy/bandwidth/refresh') ||
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
    // Only wipe the auth cookies when the refresh token is GENUINELY bad. A
    // TRANSIENT failure — the network flipping while a VPN connects, which
    // drops the in-flight getUser() request — must not nuke a valid 7-day
    // session; wiping forced operators to re-enter credentials on every VPN
    // reconnect ("this page couldn't load … login again every time"). Keeping
    // the cookies lets the session auto-restore once the network settles (the
    // /login page bounces an already-authed visitor straight back in).
    const hardAuthFailure = refreshError !== null && isHardAuthError(refreshError)
    if (refreshError) {
      url.searchParams.set('reason', hardAuthFailure ? 'session_expired' : 'network')
      console.warn(
        `[proxy] session refresh threw (${hardAuthFailure ? 'hard auth error — clearing cookies' : 'transient — keeping cookies'})`,
        refreshError,
      )
    }
    const redirect = NextResponse.redirect(url)
    if (hardAuthFailure) {
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

/**
 * True only for errors that mean the session / refresh token itself is invalid
 * (a 4xx from the auth server) — the case where wiping the cookies is right.
 * Network / timeout / 5xx failures (no HTTP status, AuthRetryableFetchError, or
 * `fetch failed`) mean we never got a verdict from the auth server — common
 * when Wi-Fi or a VPN flips mid-request — so we must KEEP the cookies and let
 * the session recover instead of forcing a full re-login.
 */
function isHardAuthError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { name?: string; status?: number; message?: string }
  if (err.name === 'AuthRetryableFetchError') return false
  if (err.name === 'TypeError' && /fetch failed|network|load failed/i.test(err.message ?? '')) {
    return false
  }
  if (typeof err.status !== 'number') return false // never reached the auth server
  if (err.status >= 500) return false // auth-server hiccup, not a bad token
  return true // 4xx on a refresh call = genuinely invalid / consumed token
}

export const config = {
  // Run on all routes except static assets + endpoints that authenticate themselves.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/monday/webhook|api/monday/sync|api/scheduler/tick|api/proxy/bandwidth/refresh|api/enrichment).*)',
  ],
}
