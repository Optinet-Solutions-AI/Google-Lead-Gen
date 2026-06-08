/**
 * Resets a user's password by user-id or email. Admin-only;
 * requires the Supabase service-role key.
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   USER_ID=<uuid>      NEW_PASSWORD=<pw> npm run auth:reset-password -- --allow-prod
 *   USER_EMAIL=<email>  NEW_PASSWORD=<pw> npm run auth:reset-password -- --allow-prod
 *
 * Notes:
 *   - Refuses to run against a hosted Supabase URL without --allow-prod.
 *   - Minimum password length 6 (Supabase's default).
 *   - Marks the user's email as confirmed so they can sign in immediately.
 *   - Logs the username (auth.users.email local-part) so you can verify
 *     you targeted the right account before sharing the new password.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const MIN_PASSWORD_LEN = 6

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
  const password = process.env.NEW_PASSWORD
  const userId = process.env.USER_ID?.trim()
  const userEmail = process.env.USER_EMAIL?.trim().toLowerCase()
  const allowProd = process.argv.includes('--allow-prod')

  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  if (!password) {
    console.error('✗ NEW_PASSWORD is required.')
    process.exit(1)
  }
  if (password.length < MIN_PASSWORD_LEN) {
    console.error(`✗ NEW_PASSWORD must be at least ${MIN_PASSWORD_LEN} characters.`)
    process.exit(1)
  }
  if (!userId && !userEmail) {
    console.error('✗ Pass either USER_ID=<uuid> or USER_EMAIL=<email>.')
    process.exit(1)
  }
  if (isProdUrl(url) && !allowProd) {
    console.error('✗ Refusing to run against a non-local Supabase project without --allow-prod.')
    process.exit(1)
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Resolve user-id from email if needed.
  let targetId = userId ?? null
  let resolvedEmail = userEmail ?? null
  if (!targetId && userEmail) {
    let page = 1
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
      if (error) throw error
      const hit = data.users.find(u => (u.email ?? '').toLowerCase() === userEmail)
      if (hit) {
        targetId = hit.id
        resolvedEmail = hit.email ?? null
        break
      }
      if (data.users.length < 200) break
      page += 1
    }
    if (!targetId) {
      console.error(`✗ No user found with email ${userEmail}.`)
      process.exit(1)
    }
  } else if (targetId && !resolvedEmail) {
    const { data, error } = await supabase.auth.admin.getUserById(targetId)
    if (error || !data.user) {
      console.error(`✗ No user found with id ${targetId}.`)
      process.exit(1)
    }
    resolvedEmail = data.user.email ?? null
  }

  console.log(`Target  : ${resolvedEmail ?? '(unknown email)'} (${targetId})`)

  const { error } = await supabase.auth.admin.updateUserById(targetId!, {
    password,
    email_confirm: true,
  })
  if (error) throw error
  console.log('✓ Password reset.')
  console.log()
  console.log('Login credentials')
  console.log(`  URL      /login`)
  console.log(`  Username ${(resolvedEmail ?? '').split('@')[0] || '(see Username admin page)'}`)
  console.log(`  Password (the value of $NEW_PASSWORD)`)
}

main().catch(err => {
  console.error('reset-password failed:')
  console.error(err)
  process.exit(1)
})
