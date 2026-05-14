/**
 * One-shot fix: populate the Website column on Monday item 1260436775
 * (Affiliates board / "askgamblers.com") so the duplicate-check matcher
 * stops missing leads for askgamblers.com. The item was created with an
 * empty Website column, so our matcher (which keys off website_normalized)
 * never finds it — leads 680 and 725 had to be manually overridden.
 *
 * Phase A only: writes to Monday. Does NOT touch the Supabase replica
 * (a separate pass clears the overrides on leads 680/725 after sync
 * pulls in the new column value).
 *
 * Run dry first (default — prints what it would do):
 *   npx tsx scripts/qa/fix-askgamblers-website.ts
 *
 * Apply for real:
 *   npx tsx scripts/qa/fix-askgamblers-website.ts --apply
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { mondayGQL } from '@/lib/monday/graphql'

loadEnv({ path: join(process.cwd(), '.env.local') })

const AFFILIATES_BOARD_ID = '1237788929'
const TARGET_ITEM_ID = '1260436775'
const WEBSITE_COLUMN_ID = 'text1'
const NEW_VALUE = 'https://www.askgamblers.com'

const APPLY = process.argv.includes('--apply')

type ItemRead = {
  items: Array<{
    id: string
    name: string
    column_values: Array<{ id: string; text: string | null }>
  }> | null
}

async function readItem(): Promise<NonNullable<ItemRead['items']>[number] | null> {
  const data = await mondayGQL<ItemRead>(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        name
        column_values { id text }
      }
    }`,
    { ids: [TARGET_ITEM_ID] },
  )
  return (data.items ?? [])[0] ?? null
}

async function writeWebsite(): Promise<{ id: string }> {
  // change_simple_column_value is the right mutation for a plain text
  // column. For typed columns (status, email, date) we'd use
  // change_column_value with JSON. text1 here is a free-form text
  // column per board-registry.ts.
  const data = await mondayGQL<{ change_simple_column_value: { id: string } }>(
    `mutation ($board_id: ID!, $item_id: ID!, $column_id: String!, $value: String!) {
      change_simple_column_value(
        board_id: $board_id,
        item_id: $item_id,
        column_id: $column_id,
        value: $value
      ) { id }
    }`,
    {
      board_id: AFFILIATES_BOARD_ID,
      item_id: TARGET_ITEM_ID,
      column_id: WEBSITE_COLUMN_ID,
      value: NEW_VALUE,
    },
  )
  return data.change_simple_column_value
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (will write to Monday)' : 'DRY-RUN'}`)
  console.log(`Target: board=${AFFILIATES_BOARD_ID}  item=${TARGET_ITEM_ID}  column=${WEBSITE_COLUMN_ID}`)
  console.log(`New value: "${NEW_VALUE}"\n`)

  console.log('--- Reading current state ---')
  const before = await readItem()
  if (!before) {
    console.error(`Item ${TARGET_ITEM_ID} not found. Aborting.`)
    process.exit(1)
  }
  console.log(`  Name:        "${before.name}"`)
  const beforeText1 = before.column_values.find(c => c.id === WEBSITE_COLUMN_ID)?.text ?? ''
  console.log(`  text1 (now): "${beforeText1}"`)

  if (before.name.toLowerCase() !== 'askgamblers.com') {
    console.error(`Safety guard: item name "${before.name}" doesn't look like "askgamblers.com". Aborting.`)
    process.exit(1)
  }
  if (beforeText1.trim().length > 0) {
    console.warn(`Note: text1 is already populated ("${beforeText1}"). Re-run with --apply only if you intend to overwrite.`)
    if (!APPLY) {
      console.log('\nDry-run complete. Nothing written.')
      return
    }
  }

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to write.')
    return
  }

  console.log('\n--- Writing ---')
  const result = await writeWebsite()
  console.log(`  change_simple_column_value returned id=${result.id}`)

  console.log('\n--- Verifying read-back ---')
  const after = await readItem()
  const afterText1 = after?.column_values.find(c => c.id === WEBSITE_COLUMN_ID)?.text ?? ''
  console.log(`  text1 (now): "${afterText1}"`)
  if (afterText1.trim() === NEW_VALUE) {
    console.log('\n✓ Write confirmed.')
  } else {
    console.error('\n✗ Read-back did not match expected value. Investigate before continuing.')
    process.exit(2)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
