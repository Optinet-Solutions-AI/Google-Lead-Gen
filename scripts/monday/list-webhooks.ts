/**
 * Lists all Monday webhooks currently registered on our 4 boards.
 *
 * Usage:  npm run monday:list-webhooks
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { BOARDS } from '@/lib/monday/board-registry'
import { mondayGQL, sleep } from '@/lib/monday/graphql'

loadEnv({ path: join(process.cwd(), '.env.local') })

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

async function main() {
  for (const board of BOARDS) {
    console.log(`\n[${board.monday_board_name}] (${board.monday_board_id})`)
    const webhooks = await listForBoard(board.monday_board_id)
    if (webhooks.length === 0) {
      console.log('  (no webhooks registered)')
    } else {
      for (const w of webhooks) {
        const url = extractUrl(w.config)
        console.log(`  ${w.id.padEnd(12)} ${w.event.padEnd(26)} → ${url}`)
      }
    }
    await sleep(400)
  }
}

function extractUrl(config: string | null): string {
  if (!config) return '(no config)'
  try {
    const parsed = JSON.parse(config) as { url?: string }
    return parsed.url ?? '(no url)'
  } catch {
    return config
  }
}

main().catch(err => {
  console.error('List failed:', err)
  process.exit(1)
})
