/**
 * Enumerates the 4 target boards on Monday.com and dumps their column
 * schemas + a few sample items (with updates) to scripts/monday/output/schemas.json.
 *
 * Run:  npm run monday:discover
 */

import { config as loadEnv } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mondayGQL, sleep } from './client.js'

// Next.js convention: local secrets live in .env.local (gitignored)
loadEnv({ path: join(process.cwd(), '.env.local') })

const TARGET_BOARD_NAMES = [
  'Leads',
  'Affiliates',
  'Not Relevant Leads',
  'Email Undelivered Leads',
]

type BoardSummary = { id: string; name: string; workspace_id: string | null }

type Column = {
  id: string
  title: string
  type: string
  settings_str: string | null
}

type Group = { id: string; title: string }

type BoardDetails = {
  id: string
  name: string
  description: string | null
  items_count: number
  columns: Column[]
  groups: Group[]
}

type ColumnValue = {
  id: string
  type: string
  text: string | null
  value: string | null
}

type Update = {
  id: string
  body: string | null
  text_body: string | null
  created_at: string | null
  creator: { id: string; name: string; email: string | null } | null
}

type Item = {
  id: string
  name: string
  created_at: string | null
  updated_at: string | null
  group: { id: string; title: string } | null
  column_values: ColumnValue[]
  updates: Update[]
}

async function listAllBoards(): Promise<BoardSummary[]> {
  // Monday's `boards` query doesn't accept a name filter — list and filter client-side.
  const data = await mondayGQL<{ boards: BoardSummary[] }>(
    `query { boards(limit: 500, state: active) { id name workspace_id } }`,
  )
  return data.boards
}

async function getBoardDetails(boardId: string): Promise<BoardDetails> {
  const data = await mondayGQL<{ boards: BoardDetails[] }>(
    `query ($id: [ID!]) {
      boards(ids: $id) {
        id
        name
        description
        items_count
        columns { id title type settings_str }
        groups  { id title }
      }
    }`,
    { id: [boardId] },
  )
  const board = data.boards[0]
  if (!board) throw new Error(`Board ${boardId} returned no details`)
  return board
}

async function getSampleItems(boardId: string, limit = 3): Promise<Item[]> {
  const data = await mondayGQL<{ boards: Array<{ items_page: { items: Item[] } }> }>(
    `query ($id: [ID!], $limit: Int!) {
      boards(ids: $id) {
        items_page(limit: $limit) {
          items {
            id
            name
            created_at
            updated_at
            group { id title }
            column_values { id type text value }
            updates(limit: 3) {
              id
              body
              text_body
              created_at
              creator { id name email }
            }
          }
        }
      }
    }`,
    { id: [boardId], limit },
  )
  return data.boards[0]?.items_page.items ?? []
}

async function main() {
  console.log('Listing all active boards on your Monday account...')
  const allBoards = await listAllBoards()
  console.log(`  found ${allBoards.length} active boards`)

  const matches = TARGET_BOARD_NAMES.map(target => {
    const board = allBoards.find(b => b.name === target)
    return { target, board }
  })

  const missing = matches.filter(m => !m.board)
  if (missing.length > 0) {
    console.error('\n✗ These target boards were not found with exact-name match:')
    for (const m of missing) console.error(`  - "${m.target}"`)
    console.error('\nBoards available on your account (up to 50):')
    for (const b of allBoards.slice(0, 50)) {
      console.error(`  - ${b.name}  (id: ${b.id})`)
    }
    process.exit(1)
  }

  const result: Array<{
    target: string
    board: BoardDetails
    sample_items: Item[]
  }> = []

  for (const { target, board } of matches) {
    console.log(`\nFetching schema for "${target}" (id: ${board!.id})...`)
    const details = await getBoardDetails(board!.id)
    await sleep(500) // gentle throttle
    const samples = await getSampleItems(board!.id)
    await sleep(500)

    result.push({ target, board: details, sample_items: samples })
  }

  // Write full dump
  const outDir = join(process.cwd(), 'scripts/monday/output')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'schemas.json')
  writeFileSync(outPath, JSON.stringify(result, null, 2))

  // Print summary
  console.log('\n' + '='.repeat(72))
  console.log('DISCOVERY SUMMARY')
  console.log('='.repeat(72))
  for (const r of result) {
    console.log(`\n[${r.target}]`)
    console.log(`  board_id     : ${r.board.id}`)
    console.log(`  items_count  : ${r.board.items_count}`)
    console.log(`  groups       : ${r.board.groups.length}`)
    console.log(`  columns      : ${r.board.columns.length}`)
    for (const c of r.board.columns) {
      const title = c.title.length > 38 ? c.title.slice(0, 35) + '...' : c.title
      console.log(`    - ${c.id.padEnd(28)} ${c.type.padEnd(14)} ${title}`)
    }
  }
  console.log('\n' + '='.repeat(72))
  console.log(`Full dump saved to: ${outPath}`)
  console.log('='.repeat(72))
}

main().catch(err => {
  console.error('\n✗ Discovery failed:')
  console.error(err)
  process.exit(1)
})
