/**
 * One-shot helper: lists every Monday board the API token can see.
 * Used to spot boards we DON'T mirror yet (and therefore miss in the
 * duplicate check). Output sorted by item count descending.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
loadEnv({ path: join(process.cwd(), '.env.local') })

import { mondayGQL } from '@/lib/monday/graphql'

type Board = {
  id: string
  name: string
  state: string
  items_count: number
  workspace?: { id: string; name: string } | null
}

async function main() {
  const data = await mondayGQL<{ boards: Board[] }>(
    `query {
      boards(limit: 200) {
        id
        name
        state
        items_count
        workspace { id name }
      }
    }`,
    {},
  )
  const active = data.boards
    .filter(b => b.state === 'active')
    .sort((a, b) => b.items_count - a.items_count)

  console.log(`${active.length} active boards visible to this API token:`)
  console.log()
  console.log('   ID         items   workspace                          name')
  console.log('   ---------- -----   ---------------------------------- ----')
  for (const b of active) {
    const ws = b.workspace?.name ?? '(no workspace)'
    console.log(
      `   ${b.id.padEnd(10)} ${String(b.items_count).padStart(5)}   ${ws.padEnd(34)} ${b.name}`,
    )
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
