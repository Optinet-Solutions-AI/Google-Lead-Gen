/**
 * Seeds (or resets) the Admin user.
 *
 *   Username : Admin
 *   Password : Admin123
 *   Stored as: admin@rooster.local  (username + @rooster.local)
 *
 * Safe to re-run — if the user already exists, resets the password
 * to the default.
 *
 * Run:  npm run auth:seed-admin
 *
 * After running, change the password immediately at /account/password.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const ADMIN_EMAIL = 'admin@rooster.local'
const ADMIN_PASSWORD = 'Admin123'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')

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
    const hit = data.users.find(u => (u.email ?? '').toLowerCase() === ADMIN_EMAIL)
    if (hit) {
      existing = hit
      break
    }
    if (data.users.length < 200) break
    page += 1
  }

  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password: ADMIN_PASSWORD,
      email_confirm: true,
    })
    if (error) throw error
    console.log(`✓ Admin user already existed (${existing.id}); password reset to default.`)
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      email_confirm: true,
    })
    if (error) throw error
    console.log(`✓ Created admin user: ${data.user?.id}`)
  }

  console.log()
  console.log('Login credentials')
  console.log(`  URL      /login`)
  console.log(`  Username Admin`)
  console.log(`  Password ${ADMIN_PASSWORD}`)
  console.log()
  console.log('⚠ Change the password immediately at /account/password after first login.')
}

main().catch(err => {
  console.error('seed-admin failed:')
  console.error(err)
  process.exit(1)
})
