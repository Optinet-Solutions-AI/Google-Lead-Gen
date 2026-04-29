/**
 * Fetches all items + updates from 4 Monday boards and upserts them
 * into the Supabase replica tables. Idempotent.
 *
 * Run:  npm run monday:sync
 *
 * Prereqs:
 *   - .env.local has MONDAY_API_TOKEN, NEXT_PUBLIC_SUPABASE_URL,
 *     SUPABASE_SERVICE_ROLE_KEY
 *
 * The actual sync logic lives in lib/monday/sync-runner.ts so the
 * Vercel cron route at /api/monday/sync can share it.
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'

loadEnv({ path: join(process.cwd(), '.env.local') })

// Imports must be after loadEnv so server-only helpers see the env vars.
async function main() {
  const { runMondaySync } = await import('@/lib/monday/sync-runner')

  const result = await runMondaySync({
    onProgress: msg => console.log(`  ${msg}`),
  })

  console.log('')
  for (const r of result.results) {
    if (r.error) {
      console.error(
        `✗ [${r.board}] failed after ${r.items} items: ${r.error}`,
      )
    } else {
      console.log(
        `✓ [${r.board}] ${r.items} items, ${r.updates} updates in ${Math.round(r.ms / 1000)}s`,
      )
    }
  }
  console.log(
    `\n${result.ok ? '✓' : '✗'} All boards processed in ${Math.round(result.ms / 1000)}s`,
  )
  if (!result.ok) process.exit(1)
}

main().catch(err => {
  console.error('\n✗ Sync failed:')
  console.error(err)
  process.exit(1)
})
