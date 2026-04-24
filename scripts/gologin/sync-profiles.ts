/**
 * Fetches all profiles from the GoLogin API and fills
 * `gologin_profiles.gologin_profile_id` in Supabase by matching on
 * `gologin_display_name` (which we seeded with the dashboard labels
 * like "011 | TP Test | Germany").
 *
 * Idempotent — re-running updates any rows whose IDs changed.
 *
 * Run: npm run gologin:sync-profiles
 *
 * Prereqs in .env.local:
 *   - GOLOGIN_API_TOKEN
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * The migration 20260424000001 must have been applied first
 * (it seeds the 15 country rows this script updates).
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const GOLOGIN_API_URL = process.env.GOLOGIN_API_URL ?? 'https://api.gologin.com'
const GOLOGIN_TOKEN = process.env.GOLOGIN_API_TOKEN
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

type GoLoginProfile = {
  id: string
  name: string
  notes?: string | null
}

type SeededRow = {
  country_code: string
  country_name: string
  gologin_profile_id: string | null
  gologin_display_name: string | null
}

/** Calls GoLogin's list-profiles endpoint. Tries v2 first, falls back to v1. */
async function listGoLoginProfiles(): Promise<GoLoginProfile[]> {
  if (!GOLOGIN_TOKEN) throw new Error('GOLOGIN_API_TOKEN is not set')

  // Request a big page so 15 profiles (and then some) fit in one call
  const url = `${GOLOGIN_API_URL}/browser/v2?limit=200`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GOLOGIN_TOKEN}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    throw new Error(
      `GoLogin API ${res.status} ${res.statusText}: ${await res.text()}`,
    )
  }

  const body: unknown = await res.json()
  const profiles = extractProfiles(body)
  return profiles
}

/**
 * GoLogin's response shape has drifted across versions. Handle the common
 * layouts defensively: plain array, `{profiles: [...]}`, or `{data: [...]}`.
 */
function extractProfiles(body: unknown): GoLoginProfile[] {
  if (Array.isArray(body)) {
    return body as GoLoginProfile[]
  }
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    if (Array.isArray(obj.profiles)) return obj.profiles as GoLoginProfile[]
    if (Array.isArray(obj.data)) return obj.data as GoLoginProfile[]
    if (Array.isArray(obj.items)) return obj.items as GoLoginProfile[]
  }
  throw new Error(
    `Unexpected GoLogin response shape. Body keys: ${
      body && typeof body === 'object' ? Object.keys(body).join(', ') : String(body)
    }`,
  )
}

async function main() {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log('Listing profiles from GoLogin…')
  const profiles = await listGoLoginProfiles()
  console.log(`  fetched ${profiles.length} profile(s)`)

  console.log('Loading seeded rows from Supabase…')
  const { data: seededData, error: seededError } = await supabase
    .from('gologin_profiles')
    .select('country_code, country_name, gologin_profile_id, gologin_display_name')
  if (seededError) throw seededError
  const seeded = (seededData ?? []) as SeededRow[]
  console.log(`  ${seeded.length} row(s) expected`)

  // Build a map keyed by display_name for fast lookup
  const byName = new Map<string, GoLoginProfile>()
  for (const p of profiles) {
    if (p.name) byName.set(p.name, p)
  }

  let updated = 0
  let skipped = 0
  const unmatched: SeededRow[] = []

  for (const row of seeded) {
    if (!row.gologin_display_name) {
      console.log(`  ? ${row.country_code} (${row.country_name}): no display_name seeded; skipping`)
      skipped++
      continue
    }

    const match = byName.get(row.gologin_display_name)
    if (!match) {
      unmatched.push(row)
      continue
    }

    if (row.gologin_profile_id === match.id) {
      console.log(`  = ${row.country_code} (${row.country_name}): already up to date`)
      skipped++
      continue
    }

    const { error } = await supabase
      .from('gologin_profiles')
      .update({
        gologin_profile_id: match.id,
        updated_at: new Date().toISOString(),
      })
      .eq('country_code', row.country_code)

    if (error) {
      console.log(`  ! ${row.country_code} (${row.country_name}): ${error.message}`)
      continue
    }

    console.log(`  ✓ ${row.country_code} (${row.country_name}) → ${match.id}`)
    updated++
  }

  console.log()
  console.log(`Done. Updated ${updated}, unchanged ${skipped}, unmatched ${unmatched.length}.`)

  if (unmatched.length > 0) {
    console.log()
    console.log('⚠ These seeded rows have no matching GoLogin profile by display_name:')
    for (const row of unmatched) {
      console.log(`  - ${row.country_code} "${row.gologin_display_name}"`)
    }
    console.log()
    console.log('GoLogin profiles found on your account (first 50):')
    for (const p of profiles.slice(0, 50)) {
      console.log(`  - "${p.name}" (id: ${p.id})`)
    }
    console.log()
    console.log(
      'Fix: either rename the profile on GoLogin to match, or update the' +
        ' `gologin_display_name` column in Supabase to match what GoLogin has, then re-run.',
    )
    process.exit(1)
  }
}

main().catch(err => {
  console.error('\nsync-profiles failed:')
  console.error(err)
  process.exit(1)
})
