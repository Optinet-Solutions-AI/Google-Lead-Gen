import { NextResponse, type NextRequest } from 'next/server'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Cross-dashboard SSO landing route.
 *
 * The central portal (a SEPARATE Supabase project) signs a short-lived JWT
 * asserting the user's email and sends the browser here with `?token=…`.
 * We verify that assertion against the portal's JWKS, JIT-provision the user
 * in OUR project, and mint a normal cookie session so they land signed in.
 *
 * Reachability: `proxy.ts` gates every route behind a Supabase session, so
 * this path is explicitly allowlisted there — an SSO arrival has no session
 * yet, and without that entry the proxy would bounce it to /login and the
 * token would never be read.
 *
 * No approval gate: this app grants access to any authenticated user
 * (`user_profiles` carries is_admin / is_shadow flags, not a pending→approved
 * status), and the `on_auth_user_created` trigger inserts the profile row
 * automatically. So there is deliberately no "mark approved" step here.
 * The maintenance-mode gate still applies — the dashboard layout redirects
 * non-admins to /maintenance, which is the same treatment password logins get.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Supabase's listUsers is paginated; cap the walk far above any real fleet
 *  so a change in pagination semantics can't spin forever (same guard as
 *  scripts/auth/seed-admin.ts). */
const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 50

// createRemoteJWKSet caches the fetched key set, so keep the instance across
// requests instead of re-fetching the JWKS on every SSO arrival.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
let jwksUrl: string | null = null

function getJwks(url: string) {
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url))
    jwksUrl = url
  }
  return jwks
}

type SsoConfig = { jwksUrl: string; issuer: string; audience: string }

/**
 * Fail closed on configuration. If PORTAL_ISSUER / SSO_AUDIENCE are unset,
 * jose treats them as "no constraint" and SKIPS those checks — a token minted
 * for a DIFFERENT dashboard would then be accepted here. Issuer + audience are
 * the whole security boundary, so a missing value must abort the login.
 *
 * Read at request time, not module scope: a module-level throw would fail
 * `next build` (which imports every route) on any deploy where these vars
 * aren't present, taking the whole app down rather than just SSO.
 */
function readSsoConfig(): SsoConfig | null {
  const jwksUrl = process.env.PORTAL_JWKS_URL
  const issuer = process.env.PORTAL_ISSUER
  const audience = process.env.SSO_AUDIENCE

  const missing = [
    !jwksUrl && 'PORTAL_JWKS_URL',
    !issuer && 'PORTAL_ISSUER',
    !audience && 'SSO_AUDIENCE',
  ].filter(Boolean)

  if (missing.length > 0 || !jwksUrl || !issuer || !audience) {
    console.error(`[portal-callback] refusing SSO — unset env: ${missing.join(', ')}`)
    return null
  }

  return { jwksUrl, issuer, audience }
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.redirect(new URL('/login', req.url))

  const config = readSsoConfig()
  if (!config) return NextResponse.redirect(new URL('/login?error=sso', req.url))

  // 1) Verify the portal's assertion (signature + issuer + audience + expiry).
  let email: string
  try {
    const { payload } = await jwtVerify(token, getJwks(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.audience,
    })
    // typeof check, not String(...): String(undefined) === 'undefined' is
    // truthy and would silently defeat this guard.
    if (typeof payload.email !== 'string' || payload.email.length === 0) {
      throw new Error('no email claim')
    }
    // Normalise to lower case — /login does the same, so this keeps one
    // identity per person instead of a case-variant duplicate.
    email = payload.email.trim().toLowerCase()
  } catch (err) {
    console.warn('[portal-callback] token verification failed', err)
    return NextResponse.redirect(new URL('/login?error=sso', req.url))
  }

  const admin = createServiceClient()

  // 2) JIT-provision by email. Walk every page — a single unpaginated
  //    listUsers() only sees the first ~50 users, so an existing operator
  //    beyond page 1 would look absent and createUser would fail on the
  //    duplicate, locking them out of SSO.
  let user: { id: string; email?: string } | null = null
  let page = 1
  while (page <= MAX_USER_PAGES) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: USERS_PER_PAGE,
    })
    if (error) {
      console.error('[portal-callback] listUsers', error)
      return NextResponse.redirect(new URL('/login?error=provision', req.url))
    }
    const hit = data.users.find(u => (u.email ?? '').toLowerCase() === email)
    if (hit) {
      user = hit
      break
    }
    if (data.users.length < USERS_PER_PAGE) break
    page += 1
  }

  if (!user) {
    // email_confirm: true — the portal already vouched for this address, and
    // an unconfirmed user can't complete the magic-link exchange below.
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (error || !data.user) {
      console.error('[portal-callback] createUser', error)
      return NextResponse.redirect(new URL('/login?error=provision', req.url))
    }
    user = data.user
    console.info(`[portal-callback] JIT-provisioned ${email} (${user.id})`)
  }

  // 3) Mint a session: generate a magic-link token server-side and redeem it
  //    with the cookie-aware client, which writes the sb-* auth cookies.
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !link.properties?.hashed_token) {
    console.error('[portal-callback] generateLink', linkErr)
    return NextResponse.redirect(new URL('/login?error=session', req.url))
  }

  const supabase = await createClient()
  const { error: otpErr } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  })
  if (otpErr) {
    console.error('[portal-callback] verifyOtp', otpErr)
    return NextResponse.redirect(new URL('/login?error=session', req.url))
  }

  return NextResponse.redirect(new URL('/', req.url))
}
