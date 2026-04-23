import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * Protects every route except:
 *   /login               — the sign-in page itself
 *   /api/monday/webhook  — Monday authenticates via HS256 JWT, not Supabase
 *   static assets        — handled by the `matcher` below
 *
 * Unauthenticated users on a protected route are redirected to /login
 * with ?from=<original-path> so the login page can bounce them back.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Never gate the webhook or the login page itself
  if (pathname.startsWith('/api/monday/webhook') || pathname.startsWith('/login')) {
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
  // Run on all routes except static assets and the webhook endpoint.
  // The `api/monday/webhook` early-return above handles that case too,
  // but excluding it from the matcher avoids even entering middleware.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/monday/webhook).*)',
  ],
}
