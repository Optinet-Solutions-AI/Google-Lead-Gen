/**
 * Apply one or more SQL migration files to Supabase via the Management API.
 *
 * Requires:
 *   SUPABASE_ACCESS_TOKEN  — personal access token (from Supabase dashboard)
 *   SUPABASE_PROJECT_ID    — the project ref
 *
 * Usage:
 *   tsx scripts/db/apply-migration.ts supabase/migrations/20260424230000_xxx.sql [more.sql]
 *       → DRY RUN: prints what would execute, makes no API calls.
 *
 *   tsx scripts/db/apply-migration.ts --apply <path> [<path>...]
 *       → COMMIT: actually executes the SQL against SUPABASE_PROJECT_ID.
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

const rawArgs = process.argv.slice(2)
const APPLY = rawArgs.includes('--apply')
const args = rawArgs.filter(a => a !== '--apply')
if (args.length === 0) {
  console.error('Usage:')
  console.error('  tsx scripts/db/apply-migration.ts <path> [<path>...]            # dry-run')
  console.error('  tsx scripts/db/apply-migration.ts --apply <path> [<path>...]    # commit')
  process.exit(1)
}

const endpoint = `https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`

function previewSql(sql: string, maxLines = 20): string {
  const lines = sql.split('\n')
  if (lines.length <= maxLines) return lines.map(l => `    ${l}`).join('\n')
  const head = lines.slice(0, maxLines).map(l => `    ${l}`).join('\n')
  return `${head}\n    … (${lines.length - maxLines} more lines, ${sql.length} chars total)`
}

async function main() {
  console.log(APPLY ? '*** APPLY MODE — will execute SQL against the configured project ***' : '*** DRY RUN — no API calls will be made ***')
  console.log(`Target project: ${PROJECT_ID}`)
  console.log(`Migrations    : ${args.length}`)
  console.log('')

  let failures = 0
  for (const path of args) {
    const sql = readFileSync(resolve(path), 'utf-8')

    if (!APPLY) {
      console.log(`--- ${path} (${sql.length} chars) ---`)
      console.log(previewSql(sql))
      console.log('')
      continue
    }

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

  if (!APPLY) {
    console.log(`Dry run only — pass --apply to execute against project ${PROJECT_ID}.`)
    return
  }
  if (failures > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
