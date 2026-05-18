/**
 * Seeds (or resets) the Admin user.
 *
 *   Username : Admin              (override with ADMIN_EMAIL)
 *   Password : $ADMIN_PASSWORD    (REQUIRED — refuses to run without it)
 *   Stored as: admin@rooster.local
 *
 * Hardened per BUGS.md #4 — previously hardcoded `Admin123` and would
 * silently re-apply on every run against whatever project SUPABASE_URL
 * pointed at, including prod.
 *
 * Required env:
 *   ADMIN_PASSWORD           — password to set (min 12 chars)
 *   NEXT_PUBLIC_SUPABASE_URL — project URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   ADMIN_EMAIL              — defaults to admin@rooster.local
 *
 * Run (against a local Supabase):
 *   ADMIN_PASSWORD=... npm run auth:seed-admin
 *
 * Run (against prod — requires explicit opt-in):
 *   ADMIN_PASSWORD=... npm run auth:seed-admin -- --allow-prod
 *
 * After running, change the password immediately at /account/password.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const DEFAULT_EMAIL = 'admin@rooster.local'
const MIN_PASSWORD_LEN = 12

/** Treat any hosted Supabase URL (`*.supabase.co` / `*.supabase.in`) as
 *  prod. Localhost / 127.0.0.1 / *.local are considered dev. */
function isProdUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false
    if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) return true
    // Unknown host — fail safe and require the flag.
    return true
  } catch {
    return true
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const password = process.env.ADMIN_PASSWORD
  const email = (process.env.ADMIN_EMAIL || DEFAULT_EMAIL).trim().toLowerCase()
  const allowProd = process.argv.includes('--allow-prod')

  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  if (!password) {
    console.error('✗ ADMIN_PASSWORD is required.')
    console.error('  Set it in your shell:  ADMIN_PASSWORD=<password> npm run auth:seed-admin')
    console.error('  Refusing to run with a default/hardcoded value.')
    process.exit(1)
  }
  if (password.length < MIN_PASSWORD_LEN) {
    console.error(`✗ ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LEN} characters.`)
    process.exit(1)
  }

  if (isProdUrl(url) && !allowProd) {
    console.error('✗ Refusing to run against a non-local Supabase project without --allow-prod.')
    console.error(`  Target URL: ${url}`)
    console.error('  Re-run with:  npm run auth:seed-admin -- --allow-prod')
    process.exit(1)
  }

  console.log(`Target  : ${url}`)
  console.log(`Account : ${email}`)
  console.log(allowProd ? '*** APPLY MODE — non-local project explicitly allowed via --allow-prod ***' : 'Local/dev project — proceeding.')
  console.log('')

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Look for an existing user by email. Supabase's listUsers is
  // paginated; we walk all pages to be safe.
  let page = 1
  let existing: { id: string; email?: string } | null = null
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const hit = data.users.find(u => (u.email ?? '').toLowerCase() === email)
    if (hit) {
      existing = hit
      break
    }
    if (data.users.length < 200) break
    page += 1
  }

  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    })
    if (error) throw error
    console.log(`✓ Admin user already existed (${existing.id}); password reset.`)
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error) throw error
    console.log(`✓ Created admin user: ${data.user?.id}`)
  }

  console.log()
  console.log('Login credentials')
  console.log(`  URL      /login`)
  console.log(`  Username ${email.split('@')[0]}`)
  console.log(`  Password (the value of $ADMIN_PASSWORD)`)
  console.log()
  console.log('⚠ Change the password immediately at /account/password after first login.')
}

main().catch(err => {
  console.error('seed-admin failed:')
  console.error(err)
  process.exit(1)
})
