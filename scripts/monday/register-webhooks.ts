/**
 * Registers Monday.com webhooks for every (board × event type) pair
 * defined in lib/monday/board-registry.ts.
 *
 * Usage:
 *   npm run monday:register-webhooks -- --url https://yourapp.vercel.app/api/monday/webhook
 *
 * The URL must be publicly reachable over HTTPS. Monday sends a
 * challenge handshake during registration; our route handler echoes
 * it back automatically.
 *
 * Idempotent-ish: listing existing webhooks first and skipping any
 * already registered for the same (board, event, url) triple.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import {
  BOARDS,
  WEBHOOK_EVENT_TYPES,
  type MondayWebhookEventType,
} from '@/lib/monday/board-registry'
import { mondayGQL, sleep } from '@/lib/monday/graphql'

loadEnv({ path: join(process.cwd(), '.env.local') })

const argv = process.argv.slice(2)
const urlFlagIdx = argv.indexOf('--url')
const WEBHOOK_URL = urlFlagIdx >= 0 ? argv[urlFlagIdx + 1] : undefined

if (!WEBHOOK_URL) {
  console.error('Missing --url flag.')
  console.error('  npm run monday:register-webhooks -- --url https://<your-domain>/api/monday/webhook')
  process.exit(1)
}
if (!WEBHOOK_URL.startsWith('https://')) {
  console.error('--url must start with https:// (Monday rejects non-HTTPS endpoints).')
  process.exit(1)
}

type ExistingWebhook = {
  id: string
  board_id: string
  event: string
  config: string | null
}

async function listWebhooks(boardId: string): Promise<ExistingWebhook[]> {
  const data = await mondayGQL<{ webhooks: ExistingWebhook[] }>(
    `query ($id: ID!) {
      webhooks(board_id: $id) { id board_id event config }
    }`,
    { id: boardId },
  )
  return data.webhooks
}

async function createWebhook(
  boardId: string,
  event: MondayWebhookEventType,
  url: string,
): Promise<string> {
  const data = await mondayGQL<{ create_webhook: { id: string; board_id: string } }>(
    `mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!) {
      create_webhook(board_id: $boardId, url: $url, event: $event) {
        id
        board_id
      }
    }`,
    { boardId, url, event },
  )
  return data.create_webhook.id
}

async function main() {
  console.log(`Target URL: ${WEBHOOK_URL}`)
  console.log(`Registering webhooks for ${BOARDS.length} boards × ${WEBHOOK_EVENT_TYPES.length} events = ${BOARDS.length * WEBHOOK_EVENT_TYPES.length} webhooks`)
  console.log()

  let created = 0
  let skipped = 0
  let failed = 0

  for (const board of BOARDS) {
    console.log(`[${board.monday_board_name}] (${board.monday_board_id})`)
    const existing = await listWebhooks(board.monday_board_id)
    const alreadyRegistered = new Set(
      existing.map(w => `${w.event}|${safeConfigUrl(w.config)}`),
    )
    await sleep(500)

    for (const event of WEBHOOK_EVENT_TYPES) {
      const key = `${event}|${WEBHOOK_URL}`
      if (alreadyRegistered.has(key)) {
        console.log(`  skip   ${event} (already registered)`)
        skipped++
        continue
      }
      try {
        const id = await createWebhook(board.monday_board_id, event, WEBHOOK_URL as string)
        console.log(`  ok     ${event} (webhook_id=${id})`)
        created++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`  FAIL   ${event}: ${msg}`)
        failed++
      }
      await sleep(500)
    }
    console.log()
  }

  console.log(`Summary: ${created} created, ${skipped} already registered, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

/**
 * Monday stores the target URL inside the `config` JSON blob, e.g.
 *   {"url":"https://...","boardId":123}
 * We parse it defensively so we can match against our target URL.
 */
function safeConfigUrl(config: string | null): string {
  if (!config) return ''
  try {
    const parsed = JSON.parse(config) as { url?: string }
    return parsed.url ?? ''
  } catch {
    return ''
  }
}

main().catch(err => {
  console.error('Registration failed:')
  console.error(err)
  process.exit(1)
})
