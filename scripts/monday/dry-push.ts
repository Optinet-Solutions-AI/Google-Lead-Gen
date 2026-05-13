/**
 * Dry-run for "Push to Monday".
 *
 * Builds the exact create_item payload that pushLeadToMonday() would
 * send for a given lead + acting user, resolves the read-only top-of-
 * board anchor against the live Monday API, and prints everything —
 * without executing any mutation. Use this to verify owner mapping,
 * column shape, and positioning anchor before risking a real push.
 *
 * Usage:
 *   npm run monday:dry-push -- --lead=<lead_id> --user=<email-or-uuid>
 *
 * Example:
 *   npm run monday:dry-push -- --lead=12345 --user=jose@optinetsolutions.com
 *
 * Prereqs (same as monday:sync):
 *   .env.local must define MONDAY_API_TOKEN, NEXT_PUBLIC_SUPABASE_URL,
 *   and SUPABASE_SERVICE_ROLE_KEY.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'

loadEnv({ path: join(process.cwd(), '.env.local') })

type Args = { leadId: number; user: string; overrideMondayId: number | null }

function parseArgs(): Args {
  let leadId: number | null = null
  let user: string | null = null
  let overrideMondayId: number | null = null
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const key = m[1]
    const val = m[2] ?? ''
    if (key === 'lead') leadId = Number(val)
    else if (key === 'user') user = val
    else if (key === 'override-monday-id') overrideMondayId = Number(val)
  }
  if (leadId == null || !Number.isFinite(leadId)) {
    console.error('Missing or invalid --lead=<id>')
    process.exit(2)
  }
  if (!user) {
    console.error('Missing --user=<email-or-auth-uuid>')
    process.exit(2)
  }
  if (overrideMondayId != null && !Number.isFinite(overrideMondayId)) {
    console.error('Invalid --override-monday-id=<number>')
    process.exit(2)
  }
  return { leadId, user, overrideMondayId }
}

// Imports must be after loadEnv so server-only helpers see the env vars.
async function main() {
  const { leadId, user, overrideMondayId } = parseArgs()

  const { createServiceClient } = await import('@/lib/supabase/service')
  const { prepareLeadPushPayload, LEADS_BOARD_ID } = await import(
    '@/lib/monday/push-lead'
  )

  const svc = createServiceClient()

  // Look up the user_profile by email or by auth UUID. Mirrors what
  // pushLeadToMondayAction does after auth.getUser(), minus the
  // session — the script accepts the user identity as an arg.
  const isUuid = /^[0-9a-f-]{36}$/i.test(user)
  const profileQuery = svc
    .from('user_profiles')
    .select('id, username, display_name, monday_user_id')
  const { data: profileRow, error: profileErr } = isUuid
    ? await profileQuery.eq('id', user).maybeSingle()
    : await profileQuery.eq('username', user).maybeSingle()

  if (profileErr) {
    console.error(`Profile lookup failed: ${profileErr.message}`)
    process.exit(1)
  }
  if (!profileRow) {
    console.error(`No user_profile found for ${user}.`)
    const { data: candidates } = await svc
      .from('user_profiles')
      .select('id, username, display_name, monday_user_id')
      .order('username')
      .limit(40)
    if (candidates && candidates.length > 0) {
      console.error('')
      console.error('Existing user_profiles (pass --user=<id> or --user=<username>):')
      console.table(candidates)
    }
    process.exit(1)
  }

  const profile = profileRow as {
    id: string
    username: string | null
    display_name: string | null
    monday_user_id: number | null
  }

  const pushedByDisplay =
    profile.display_name ?? profile.username ?? profile.id
  const pushedByMondayId =
    overrideMondayId != null ? overrideMondayId : profile.monday_user_id

  console.log('─── Resolved acting user ──────────────────────────────────────')
  console.log({
    auth_id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    monday_user_id_in_db: profile.monday_user_id,
    monday_user_id_effective: pushedByMondayId,
    using_override: overrideMondayId != null,
    pushedBy_display: pushedByDisplay,
  })

  if (pushedByMondayId == null) {
    console.log('')
    console.log(
      '⚠ This user has NO monday_user_id set. A real push would be BLOCKED with:',
    )
    console.log(
      '   "Your account is not linked to a Monday user yet. Ask an admin to set',
    )
    console.log('    your Monday ID at /admin/users so pushes land under you."')
    console.log('')
    console.log(
      'Tip: re-run with a --user whose monday_user_id is populated, or seed one',
    )
    console.log(
      '     for this user first via /admin/users (or directly in user_profiles).',
    )
    process.exit(0)
  }

  const result = await prepareLeadPushPayload(leadId, {
    pushedBy: pushedByDisplay,
    pushedByMondayId,
  })
  if (!result.ok) {
    console.error('')
    console.error(`prepareLeadPushPayload failed: ${result.error}`)
    process.exit(1)
  }
  const data = result.data

  console.log('')
  console.log('─── Resolved lead metadata ─────────────────────────────────────')
  console.log(data.meta)

  console.log('')
  console.log('─── Top-of-board anchor (live Monday read) ─────────────────────')
  if (data.anchor) {
    console.log(
      `Will position new item BEFORE item ${data.anchor.itemId} in group ${data.anchor.groupId}.`,
    )
  } else {
    console.log(
      'No anchor found — would fall back to plain create_item (lands at bottom of default group).',
    )
  }

  console.log('')
  console.log('─── create_item payload that WOULD be sent ─────────────────────')
  const wouldSend = data.anchor
    ? {
        board_id: LEADS_BOARD_ID,
        group_id: data.anchor.groupId,
        item_name: data.itemName,
        position_relative_method: 'before_at',
        relative_to: data.anchor.itemId,
        column_values: data.columnValues,
      }
    : {
        board_id: LEADS_BOARD_ID,
        item_name: data.itemName,
        column_values: data.columnValues,
      }
  console.log(JSON.stringify(wouldSend, null, 2))

  console.log('')
  console.log('─── Post-create steps that WOULD run ───────────────────────────')
  console.log(
    `  • screenshot upload: ${data.lead.screenshot_content_link ? 'YES → ' + data.lead.screenshot_content_link : 'no (no screenshot on lead)'}`,
  )
  console.log(
    `  • s-tag update post: ${data.stags.length > 0 ? `YES (${data.stags.length} tags)` : 'no (no s-tags on lead)'}`,
  )

  console.log('')
  console.log('✓ Dry run complete. No mutations executed against Monday.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
