/**
 * Probe whether 20260522060000's function-replace landed even though
 * the Supabase SQL editor reported a dashboard timeout on the backfill.
 * Read-only.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const targets = ['casinoohneoasis.com', 'onlinecasinoohneoasis.com']
  for (const d of targets) {
    const { data, error } = await svc.rpc('search_website_on_monday', { p_domain: d })
    if (error) { console.log(`${d}: ERROR ${error.message}`); continue }
    console.log(`${d}: ${(data ?? []).length} hits`)
    for (const m of (data ?? []) as Array<{ board: string; item_id: string; item_name: string; match_kind: string }>) {
      console.log(`  ✓ ${m.board} / ${m.item_id} / "${m.item_name}" — ${m.match_kind}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
