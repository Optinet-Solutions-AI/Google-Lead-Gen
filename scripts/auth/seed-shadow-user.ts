/**
 * Seeds (or resets) a shadow user — an admin-privileged account
 * whose work is invisible to non-shadow viewers and which itself
 * cannot see non-shadow viewers' work. The bidirectional isolation
 * is enforced at the dashboard query layer (see lib/shadow-filter.ts);
 * the DB just carries the flags.
 *
 *   Username : $SHADOW_USERNAME    (defaults to 'Meny' — used as the local
 *                                   part of <username>@rooster.local)
 *   Password : $SHADOW_PASSWORD    (REQUIRED — refuses to run without it)
 *
 * Required env:
 *   SHADOW_PASSWORD          — password to set (min 6 chars)
 *   NEXT_PUBLIC_SUPABASE_URL — project URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   SHADOW_USERNAME          — defaults to 'Meny'
 *   SHADOW_DISPLAY_NAME      — defaults to the username
 *
 * Run:
 *   SHADOW_PASSWORD=Meny123 npm run auth:seed-shadow-user -- --allow-prod
 *
 * After creating, the user signs in at /login with the same flow as
 * everyone else. The isolation only kicks in once the migration
 * 20260528220000_shadow_user.sql is applied and the dashboard filter
 * code is deployed.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const DEFAULT_USERNAME = 'Meny'
const EMAIL_DOMAIN = '@rooster.local'
const MIN_PASSWORD_LEN = 6 // matches Supabase's default policy

function isProdUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false
    if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) return true
    return true
  } catch {
    return true
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const password = process.env.SHADOW_PASSWORD
  const username = (process.env.SHADOW_USERNAME || DEFAULT_USERNAME).trim()
  const displayName = (process.env.SHADOW_DISPLAY_NAME || username).trim()
  const allowProd = process.argv.includes('--allow-prod')

  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  if (!password) {
    console.error('✗ SHADOW_PASSWORD is required.')
    console.error('  Set it in your shell:  SHADOW_PASSWORD=<password> npm run auth:seed-shadow-user')
    process.exit(1)
  }
  if (password.length < MIN_PASSWORD_LEN) {
    console.error(`✗ SHADOW_PASSWORD must be at least ${MIN_PASSWORD_LEN} characters.`)
    process.exit(1)
  }

  const email = `${username.toLowerCase()}${EMAIL_DOMAIN}`

  if (isProdUrl(url) && !allowProd) {
    console.error('✗ Refusing to run against a non-local Supabase project without --allow-prod.')
    console.error(`  Target URL: ${url}`)
    console.error('  Re-run with:  npm run auth:seed-shadow-user -- --allow-prod')
    process.exit(1)
  }

  console.log(`Target   : ${url}`)
  console.log(`Account  : ${email}`)
  console.log(`Username : ${username}`)
  console.log(`Display  : ${displayName}`)
  console.log(allowProd ? '*** APPLY MODE — non-local project explicitly allowed via --allow-prod ***' : 'Local/dev project — proceeding.')
  console.log('')

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Walk auth.users to find an existing entry by email.
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

  let userId: string
  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    })
    if (error) throw error
    userId = existing.id
    console.log(`✓ Account already existed (${userId}); password reset.`)
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error) throw error
    userId = data.user!.id
    console.log(`✓ Created auth user: ${userId}`)
  }

  // Mark the profile as both admin and shadow. The handle_new_auth_user
  // trigger created a row with is_admin=false on auth-user insert; we
  // upgrade it here.
  const { error: profileErr } = await supabase
    .from('user_profiles')
    .upsert(
      {
        id: userId,
        is_admin: true,
        is_shadow: true,
        username,
        display_name: displayName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
  if (profileErr) throw profileErr
  console.log(`✓ Profile set to is_admin=true, is_shadow=true.`)

  console.log()
  console.log('Login credentials')
  console.log(`  URL      /login`)
  console.log(`  Username ${username}`)
  console.log(`  Password (the value of $SHADOW_PASSWORD)`)
  console.log()
  console.log('⚠ This account is shadow-isolated:')
  console.log('  - Other users do NOT see this user\'s scrapes, leads, or enrichments.')
  console.log('  - This user does NOT see other users\' work either.')
  console.log('  - Both directions only kick in once migration')
  console.log('    20260528220000_shadow_user.sql is applied AND the dashboard')
  console.log('    is deployed with the lib/shadow-filter.ts wiring.')
}

main().catch(err => {
  console.error('seed-shadow-user failed:')
  console.error(err)
  process.exit(1)
})
