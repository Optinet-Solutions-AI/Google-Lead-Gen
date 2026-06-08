/**
 * Flips the GoLogin profiles used for Google-login scraping from a ROTATING
 * Enigma exit to a STICKY one (a stable IP per country).
 *
 * WHY: Google logs an account out the moment its egress IP changes. Our resi
 * proxy (Enigma) rotates the IP mid-session, so Google invalidates the session
 * and then demands an OTP we never receive — the loop QA reported. scraper.py
 * already *detects* this ("IP-Adresse: A ≠ B", see vm/scraper.py ~L2001) but
 * can only fail-and-retry; the real fix is to stop the IP from rotating. The
 * proxy isn't set in our code at runtime — gl.start() uses whatever proxy is
 * stored ON the GoLogin profile — so the fix is to rewrite that stored proxy.
 *
 * HOW (read-modify-write — deliberately conservative): for each target profile
 * we GET its current proxy, verify it's the rotating Enigma proxy, and APPEND a
 * sticky-session token to the existing password. mode / host / port / username
 * are preserved exactly (the Enigma proxy is socks5 — we must NOT rewrite that).
 * Anything that isn't the rotating Enigma proxy (e.g. a ProxyLite entry, or one
 * already made sticky) is skipped untouched.
 *
 * SCOPE: every country row flagged `requires_google_login = true` with a known
 * `gologin_profile_id`. NOTE: there is ONE GoLogin profile per country, shared
 * by ALL engines (Google, Bing, X, FB, …). Making it sticky makes it sticky for
 * everything that runs on that country — weigh the Bing tradeoff before --apply.
 *
 * SAFETY: dry-run by default. It prints the before/after password (secret
 * masked) and changes nothing. Pass --apply to actually PATCH the profiles.
 *
 * Run:
 *   npm run gologin:set-sticky-proxy            # dry run — preview only
 *   npm run gologin:set-sticky-proxy -- --apply # actually update the profiles
 *
 * Prereqs in .env.local:
 *   - GOLOGIN_API_TOKEN
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - ENIGMA_STICKY_SUFFIX_TEMPLATE (optional, default `_session-sticky{country}`)
 *        The token Enigma uses to pin a STABLE IP, appended to the existing
 *        `<secret>_country-XX` password. `{country}` → ISO-2 (uppercase) so each
 *        country gets a distinct, stable session id. CONFIRM the exact syntax in
 *        your Enigma dashboard — providers vary (`_session-`, length rules, an
 *        optional `_lifetime-<minutes>`). Examples of the shape:
 *           _session-sticky{country}
 *           _session-sticky{country}_lifetime-60
 *        Keep the session value STABLE per country (that's what holds the IP).
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const GOLOGIN_API_URL = process.env.GOLOGIN_API_URL ?? 'https://api.gologin.com'
const GOLOGIN_TOKEN = process.env.GOLOGIN_API_TOKEN
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const STICKY_SUFFIX_TEMPLATE =
  process.env.ENIGMA_STICKY_SUFFIX_TEMPLATE ?? '_session-sticky{country}'

const APPLY = process.argv.includes('--apply')

type ProfileRow = {
  country_code: string
  country_name: string
  gologin_profile_id: string
}

type GoLoginProxy = {
  mode?: string
  host?: string
  port?: number
  username?: string
  password?: string
}

/** Masks the fixed Enigma secret, leaving the country/session suffix visible. */
function maskPassword(pw: string): string {
  const i = pw.indexOf('_')
  if (i <= 0) return '••••'
  return '••••' + pw.slice(i)
}

async function getProxy(profileId: string): Promise<GoLoginProxy> {
  const res = await fetch(`${GOLOGIN_API_URL}/browser/${profileId}`, {
    headers: { Authorization: `Bearer ${GOLOGIN_TOKEN}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`GoLogin GET ${res.status} ${res.statusText}: ${await res.text()}`)
  }
  const body = (await res.json()) as { proxy?: GoLoginProxy }
  return body.proxy ?? {}
}

async function patchProxy(profileId: string, proxy: GoLoginProxy): Promise<void> {
  const res = await fetch(`${GOLOGIN_API_URL}/browser/${profileId}/proxy`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${GOLOGIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(proxy),
  })
  // GoLogin returns 200 or 204 on success.
  if (!res.ok) {
    throw new Error(`GoLogin PATCH ${res.status} ${res.statusText}: ${await res.text()}`)
  }
}

async function main() {
  if (!GOLOGIN_TOKEN) throw new Error('GOLOGIN_API_TOKEN is not set')
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  if (!STICKY_SUFFIX_TEMPLATE.includes('{country}')) {
    throw new Error(
      'ENIGMA_STICKY_SUFFIX_TEMPLATE has no {country} placeholder — every country ' +
        'would share one session id (one IP). Add {country} to the template.',
    )
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log('Loading Google-login countries from Supabase…')
  const { data, error } = await supabase
    .from('gologin_profiles')
    .select('country_code, country_name, gologin_profile_id')
    .eq('requires_google_login', true)
    .not('gologin_profile_id', 'is', null)
    .order('country_code')
  if (error) throw error

  const rows = (data ?? []) as ProfileRow[]
  if (rows.length === 0) {
    console.log('No countries flagged requires_google_login with a gologin_profile_id. Nothing to do.')
    return
  }

  console.log(
    `\n${APPLY ? '⚙ APPLYING' : '🔍 DRY RUN (no changes — pass --apply to write)'}: ` +
      `${rows.length} profile(s)\n`,
  )

  let ok = 0
  let skipped = 0
  let failed = 0

  for (const row of rows) {
    const tag = `${row.country_code} (${row.country_name})`
    let proxy: GoLoginProxy
    try {
      proxy = await getProxy(row.gologin_profile_id)
    } catch (err) {
      console.log(`  ! ${tag}: ${(err as Error).message}`)
      failed++
      continue
    }

    const pw = proxy.password ?? ''

    // Guard: only touch the rotating Enigma proxy. Leave ProxyLite / unknown
    // proxies and already-sticky ones alone.
    if (!/enigmaproxy/i.test(proxy.host ?? '')) {
      console.log(`  – ${tag}: proxy host is "${proxy.host ?? '(none)'}", not Enigma — skipping`)
      skipped++
      continue
    }
    if (pw.includes('_session-')) {
      console.log(`  = ${tag}: already sticky (${maskPassword(pw)}) — skipping`)
      skipped++
      continue
    }
    if (!pw.includes('_country-')) {
      console.log(`  – ${tag}: password isn't the expected "<secret>_country-XX" form (${maskPassword(pw)}) — skipping`)
      skipped++
      continue
    }

    const suffix = STICKY_SUFFIX_TEMPLATE.replace(/\{country\}/g, row.country_code.toUpperCase())
    const newProxy: GoLoginProxy = { ...proxy, password: pw + suffix }

    console.log(`  • ${tag}  [${proxy.mode} ${proxy.host}:${proxy.port}]`)
    console.log(`      ${maskPassword(pw)}  →  ${maskPassword(newProxy.password!)}`)

    if (!APPLY) {
      skipped++
      continue
    }

    try {
      await patchProxy(row.gologin_profile_id, newProxy)
      console.log(`      ✓ applied`)
      ok++
    } catch (err) {
      console.log(`      ! ${(err as Error).message}`)
      failed++
    }
  }

  console.log()
  if (APPLY) {
    console.log(`Done. Updated ${ok}, skipped ${skipped}, failed ${failed}.`)
    if (failed > 0) process.exit(1)
  } else {
    console.log(`Dry run complete (${skipped} previewed, ${failed} errored). Re-run with \`-- --apply\` to write.`)
    if (failed > 0) process.exit(1)
  }
}

main().catch(err => {
  console.error('\nset-sticky-proxy failed:')
  console.error(err)
  process.exit(1)
})
