/**
 * Reproduce the date-eq filter bug Charisse reported: filtering /scrape
 * by Started at = 16/06/2026 + Owner contains "charisse" returns zero
 * rows even when jobs exist. Run before/after the fix to verify.
 *
 *   npx tsx scripts/qa/repro-date-eq-filter.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing supabase env')
  const svc = createClient(url, key, { auth: { persistSession: false } })

  console.log('=== A. Naive eq (current /scrape behaviour) ===')
  const naive = await svc
    .from('scrape_queue')
    .select('id, keyword, created_by_display, started_at')
    .ilike('created_by_display', '%charisse%')
    .eq('started_at', '2026-06-16T00:00')
    .limit(5)
  console.log('error:', naive.error)
  console.log('rows:', naive.data?.length ?? 0)

  console.log('\n=== B. Same-day range (the fix) ===')
  const fixed = await svc
    .from('scrape_queue')
    .select('id, keyword, created_by_display, started_at')
    .ilike('created_by_display', '%charisse%')
    .gte('started_at', '2026-06-16T00:00:00Z')
    .lt('started_at', '2026-06-17T00:00:00Z')
    .limit(5)
  console.log('error:', fixed.error)
  console.log('rows:', fixed.data?.length ?? 0)
  for (const r of (fixed.data ?? []) as Array<{
    id: string
    keyword: string
    created_by_display: string | null
    started_at: string | null
  }>) {
    console.log(`  ${r.started_at}  ${r.created_by_display}  ${r.keyword}`)
  }

  console.log('\n=== C. How many of Charisse\'s jobs touched June 2026 at all? ===')
  const wider = await svc
    .from('scrape_queue')
    .select('started_at', { count: 'exact', head: true })
    .ilike('created_by_display', '%charisse%')
    .gte('started_at', '2026-06-01T00:00:00Z')
    .lt('started_at', '2026-07-01T00:00:00Z')
  console.log('rows:', wider.count ?? 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
