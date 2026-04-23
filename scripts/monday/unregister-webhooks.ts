/**
 * Unregisters (deletes) Monday webhooks from our 4 boards.
 *
 * Usage:
 *   npm run monday:unregister-webhooks -- --confirm             # deletes ALL webhooks on the 4 boards
 *   npm run monday:unregister-webhooks -- --confirm --url https://...   # deletes only webhooks pointing at a specific URL
 *
 * Requires the explicit --confirm flag to prevent accidental deletion.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { BOARDS } from '@/lib/monday/board-registry'
import { mondayGQL, sleep } from '@/lib/monday/graphql'

loadEnv({ path: join(process.cwd(), '.env.local') })

const argv = process.argv.slice(2)
const hasConfirm = argv.includes('--confirm')
const urlIdx = argv.indexOf('--url')
const filterUrl = urlIdx >= 0 ? argv[urlIdx + 1] : undefined

if (!hasConfirm) {
  console.error('Refusing to run without --confirm flag.')
  console.error('  npm run monday:unregister-webhooks -- --confirm')
  console.error('  npm run monday:unregister-webhooks -- --confirm --url https://<url>')
  process.exit(1)
}

type ExistingWebhook = {
  id: string
  board_id: string
  event: string
  config: string | null
}

async function listForBoard(boardId: string): Promise<ExistingWebhook[]> {
  const data = await mondayGQL<{ webhooks: ExistingWebhook[] }>(
    `query ($id: ID!) {
      webhooks(board_id: $id) { id board_id event config }
    }`,
    { id: boardId },
  )
  return data.webhooks
}

async function deleteWebhook(id: string): Promise<void> {
  await mondayGQL(
    `mutation ($id: ID!) {
      delete_webhook(id: $id) { id }
    }`,
    { id },
  )
}

async function main() {
  if (filterUrl) console.log(`Filter: deleting only webhooks pointing at ${filterUrl}`)
  else console.log('Deleting ALL webhooks on the 4 configured boards')

  let deleted = 0
  let kept = 0

  for (const board of BOARDS) {
    console.log(`\n[${board.monday_board_name}]`)
    const webhooks = await listForBoard(board.monday_board_id)
    await sleep(400)

    for (const w of webhooks) {
      const url = extractUrl(w.config)
      if (filterUrl && url !== filterUrl) {
        console.log(`  keep   ${w.id.padEnd(12)} ${w.event.padEnd(26)} (different URL)`)
        kept++
        continue
      }
      try {
        await deleteWebhook(w.id)
        console.log(`  del    ${w.id.padEnd(12)} ${w.event.padEnd(26)} → ${url}`)
        deleted++
      } catch (err) {
        console.log(`  FAIL   ${w.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      await sleep(400)
    }
  }

  console.log(`\nSummary: ${deleted} deleted, ${kept} kept`)
}

function extractUrl(config: string | null): string {
  if (!config) return ''
  try {
    const parsed = JSON.parse(config) as { url?: string }
    return parsed.url ?? ''
  } catch {
    return ''
  }
}

main().catch(err => {
  console.error('Unregister failed:', err)
  process.exit(1)
})
