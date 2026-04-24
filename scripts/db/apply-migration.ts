/**
 * Apply one or more SQL migration files to Supabase via the Management API.
 *
 * Requires:
 *   SUPABASE_ACCESS_TOKEN  — personal access token (from Supabase dashboard)
 *   SUPABASE_PROJECT_ID    — the project ref
 *
 * Usage:
 *   tsx scripts/db/apply-migration.ts supabase/migrations/20260424230000_xxx.sql [more.sql]
 *
 * Migrations should be idempotent (use IF NOT EXISTS / CREATE OR REPLACE) so
 * re-running this is safe.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(process.cwd(), '.env.local') })

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const PROJECT_ID = process.env.SUPABASE_PROJECT_ID

if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN missing — set it in .env.local')
  process.exit(1)
}
if (!PROJECT_ID) {
  console.error('SUPABASE_PROJECT_ID missing — set it in .env.local')
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: tsx scripts/db/apply-migration.ts <path> [<path>...]')
  process.exit(1)
}

const endpoint = `https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`

async function main() {
  let failures = 0
  for (const path of args) {
    const sql = readFileSync(resolve(path), 'utf-8')
    process.stdout.write(`Applying ${path} (${sql.length} chars)... `)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    })
    if (!res.ok) {
      const txt = await res.text()
      console.log('FAILED')
      console.error(`  ${res.status}: ${txt}`)
      failures++
    } else {
      console.log('OK')
    }
  }
  if (failures > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
