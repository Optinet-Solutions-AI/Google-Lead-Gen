/**
 * Replace the residential proxy on every GoLogin country profile in one go.
 *
 * WHY: the proxy is NOT stored anywhere in this app — `gologin_profiles` holds
 * only the profile id and country. The connection lives on the GoLogin profile
 * itself, so when the provider changes its endpoint the only place to fix it is
 * GoLogin, across ~19 profiles. Doing that by hand is slow and easy to get
 * wrong, because each country carries its OWN password (the country is encoded
 * in it as `_country-XX`).
 *
 * WHAT IT DOES (read-modify-write, conservative): for each active profile it
 * GETs the current proxy, swaps in the new host / port / mode / username, and
 * preserves the per-country password unless you supply a new secret — in which
 * case it rebuilds the password as `<secret>_country-XX`, keeping any extra
 * tokens (e.g. a sticky `_session-…`) that were already there.
 *
 * SAFETY: dry-run by default; prints a before/after table with secrets masked.
 * Nothing is written until you pass --apply.
 *
 * Usage
 *   # preview a straight endpoint swap (keeps existing credentials)
 *   npx tsx scripts/gologin/set-proxy-endpoint.ts --host resi2.enigmaproxy.net --port 12321
 *
 *   # endpoint + new account credentials
 *   npx tsx scripts/gologin/set-proxy-endpoint.ts \
 *       --host NEW_HOST --port 12321 --username NEWUSER --secret NEWSECRET
 *
 *   # include the countries that currently have NO proxy (OM, QA)
 *   npx tsx scripts/gologin/set-proxy-endpoint.ts --host ... --port ... --secret ... --include-unset
 *
 *   # actually write
 *   ... --apply
 *
 * After applying, prove it works end to end:
 *   npx tsx scripts/qa/_proxy-auth-test.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const GOLOGIN_API_URL = process.env.GOLOGIN_API_URL ?? 'https://api.gologin.com'
const GOLOGIN_TOKEN = process.env.GOLOGIN_API_TOKEN
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const argv = process.argv.slice(2)
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (n: string) => argv.includes(`--${n}`)

const NEW_HOST = arg('host')
const NEW_PORT = arg('port') ? Number(arg('port')) : undefined
const NEW_MODE = arg('mode') ?? 'socks5'
const NEW_USERNAME = arg('username')
const NEW_SECRET = arg('secret')
const ONLY = arg('country')?.toUpperCase()
const INCLUDE_UNSET = has('include-unset')
const APPLY = has('apply')

type GoLoginProxy = {
  mode?: string
  host?: string
  port?: number
  username?: string
  password?: string
}

/** `secret_country-NO_session-x` → shows only the non-secret tail. */
function maskPassword(pw: string | undefined): string {
  if (!pw) return '—'
  const i = pw.indexOf('_')
  return i <= 0 ? '••••' : '••••' + pw.slice(i)
}

/** Everything after the secret: `_country-NO_session-abc`. */
function credentialTail(pw: string | undefined): string {
  if (!pw) return ''
  const i = pw.indexOf('_')
  return i <= 0 ? '' : pw.slice(i)
}

async function getProfile(profileId: string): Promise<GoLoginProxy> {
  const res = await fetch(`${GOLOGIN_API_URL}/browser/${profileId}`, {
    headers: { Authorization: `Bearer ${GOLOGIN_TOKEN}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GET ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const body = (await res.json()) as { proxy?: GoLoginProxy }
  return body.proxy ?? {}
}

async function patchProxy(profileId: string, proxy: GoLoginProxy): Promise<void> {
  const res = await fetch(`${GOLOGIN_API_URL}/browser/${profileId}/proxy`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${GOLOGIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(proxy),
  })
  if (!res.ok) throw new Error(`PATCH ${res.status}: ${(await res.text()).slice(0, 120)}`)
}

async function main() {
  if (!GOLOGIN_TOKEN) throw new Error('GOLOGIN_API_TOKEN is not set')
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env is not set')
  if (!NEW_HOST || !NEW_PORT) {
    throw new Error('Give at least --host and --port (the new endpoint from the provider).')
  }
  if (INCLUDE_UNSET && !NEW_SECRET) {
    throw new Error('--include-unset needs --secret: a profile with no proxy has no password to preserve.')
  }

  const svc = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  let q = svc
    .from('gologin_profiles')
    .select('country_code, country_name, gologin_profile_id, is_active')
    .eq('is_active', true)
    .order('country_code')
  if (ONLY) q = q.eq('country_code', ONLY)
  const { data, error } = await q
  if (error) throw error

  const profiles = ((data ?? []) as Array<{
    country_code: string
    gologin_profile_id: string | null
  }>).filter(p => p.gologin_profile_id)

  console.log(
    `${APPLY ? '*** APPLY ***' : 'DRY RUN (nothing written)'}  ->  ${NEW_MODE} ${NEW_HOST}:${NEW_PORT}` +
    `${NEW_USERNAME ? '  username=REPLACED' : '  username=kept'}` +
    `${NEW_SECRET ? '  secret=REPLACED' : '  secret=kept'}\n`,
  )

  let changed = 0
  let skipped = 0
  const failures: string[] = []

  for (const p of profiles) {
    const cc = p.country_code
    let current: GoLoginProxy
    try {
      current = await getProfile(p.gologin_profile_id!)
    } catch (e) {
      failures.push(`${cc}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    const hadProxy = Boolean(current.host) && current.mode !== 'none'
    if (!hadProxy && !INCLUDE_UNSET) {
      console.log(`${cc.padEnd(3)} SKIP  no proxy set (pass --include-unset to configure it)`)
      skipped++
      continue
    }

    // Password: keep the country-specific one unless a new secret is given, in
    // which case rebuild it as <secret><existing tail>, defaulting the tail to
    // _country-XX when there was nothing to preserve.
    let password = current.password
    if (NEW_SECRET) {
      const tail = credentialTail(current.password) || `_country-${cc.toLowerCase()}`
      password = `${NEW_SECRET}${tail}`
    }
    if (!password) {
      console.log(`${cc.padEnd(3)} SKIP  no password available and no --secret given`)
      skipped++
      continue
    }

    const username = NEW_USERNAME ?? current.username
    if (!username) {
      console.log(`${cc.padEnd(3)} SKIP  no username available and no --username given`)
      skipped++
      continue
    }
    const next: GoLoginProxy = {
      mode: NEW_MODE,
      host: NEW_HOST,
      port: NEW_PORT,
      username,
      password,
    }

    console.log(
      `${cc.padEnd(3)} ${hadProxy ? 'UPDATE' : 'SET   '} ` +
      `${(current.host ?? '(none)')}:${current.port ?? '-'} -> ${NEW_HOST}:${NEW_PORT}  ` +
      `pass ${maskPassword(current.password)} -> ${maskPassword(password)}`,
    )

    if (APPLY) {
      try {
        await patchProxy(p.gologin_profile_id!, next)
        changed++
      } catch (e) {
        failures.push(`${cc}: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      changed++
    }
  }

  console.log(
    `\n${APPLY ? 'updated' : 'would update'} ${changed}, skipped ${skipped}` +
    (failures.length ? `, ${failures.length} failed` : ''),
  )
  if (failures.length) console.log('failures:\n  ' + failures.join('\n  '))
  if (!APPLY) console.log('\nRe-run with --apply to write. Then: npx tsx scripts/qa/_proxy-auth-test.ts')
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
