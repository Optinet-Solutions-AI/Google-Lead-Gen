/**
 * Targeted sync: check whether the Monday webhook propagated the
 * website-column edit on item 1260436775 to our affiliates_table. If
 * not, patch it directly using the value we just confirmed on Monday.
 *
 * Why not a full board sync: runMondaySync() walks all 4 boards at
 * 700ms/page and would take several minutes. For one row, a direct
 * UPDATE is fine — `website_normalized` is a generated column off
 * `website`, so writing `website` repopulates it automatically.
 *
 * Modes:
 *   default     read-only check
 *   --apply     write the value if missing
 *
 * Run:
 *   npx tsx scripts/qa/sync-askgamblers-row.ts            # check
 *   npx tsx scripts/qa/sync-askgamblers-row.ts --apply    # patch
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const ITEM_ID = '1260436775'
const NEW_WEBSITE = 'https://www.askgamblers.com'

const APPLY = process.argv.includes('--apply')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`Target: affiliates_table row monday_item_id=${ITEM_ID}\n`)

  const { data: before, error: beforeErr } = await svc
    .from('affiliates_table')
    .select('monday_item_id, name, website, website_normalized')
    .eq('monday_item_id', ITEM_ID)
    .maybeSingle()
  if (beforeErr) throw beforeErr
  if (!before) {
    console.error('Row not found in affiliates_table. Aborting.')
    process.exit(1)
  }
  console.log('--- Current state in our DB ---')
  console.log(`  name:                "${before.name}"`)
  console.log(`  website:             "${before.website ?? ''}"`)
  console.log(`  website_normalized:  "${before.website_normalized ?? ''}"`)

  const dbWebsite = (before.website ?? '').trim()
  if (dbWebsite.length > 0) {
    console.log('\n✓ Already populated (webhook propagated). No patch needed.')
    return
  }

  if (!APPLY) {
    console.log('\nWebsite is empty. Re-run with --apply to patch directly.')
    return
  }

  console.log('\n--- Patching affiliates_table.website ---')
  const { error: updErr } = await svc
    .from('affiliates_table')
    .update({ website: NEW_WEBSITE })
    .eq('monday_item_id', ITEM_ID)
  if (updErr) {
    console.error(`Update failed: ${updErr.message}`)
    process.exit(2)
  }

  const { data: after, error: afterErr } = await svc
    .from('affiliates_table')
    .select('website, website_normalized')
    .eq('monday_item_id', ITEM_ID)
    .maybeSingle()
  if (afterErr) throw afterErr
  console.log(`  website (now):            "${after?.website ?? ''}"`)
  console.log(`  website_normalized (now): "${after?.website_normalized ?? ''}"`)

  if ((after?.website_normalized ?? '') === 'askgamblers.com') {
    console.log('\n✓ Patched. website_normalized regenerated correctly.')
  } else {
    console.error('\n✗ website_normalized did not regenerate to "askgamblers.com". Investigate.')
    process.exit(3)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
