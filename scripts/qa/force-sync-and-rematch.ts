/**
 * One-shot: force a full Monday sync, then re-match every lead.
 *
 * Step 1 — POST /api/monday/sync?full=1 with the CRON_SECRET bearer
 *          token. Bursts all four boards back into the replica.
 *
 * Step 2 — Call rematch_monday_for_all_leads directly via the
 *          service-role client, just in case the deployed Vercel
 *          build hasn't picked up the new rematch hook yet.
 *
 *   CRON_SECRET=... npx tsx scripts/qa/force-sync-and-rematch.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const VERCEL_URL = process.env.SYNC_URL ?? 'https://google-lead-gen.vercel.app'

async function main() {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('CRON_SECRET not set in env. Cannot call /api/monday/sync.')
    console.error('Add it to .env.local OR run with: CRON_SECRET=... npx tsx scripts/qa/force-sync-and-rematch.ts')
    process.exit(1)
  }

  // ----- Step 1: trigger the full sync -----
  console.log(`POST ${VERCEL_URL}/api/monday/sync?full=1 …`)
  const t0 = Date.now()
  const res = await fetch(`${VERCEL_URL}/api/monday/sync?full=1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      Accept: 'application/json',
    },
  })
  const text = await res.text()
  console.log(`  status: ${res.status}  ms: ${Date.now() - t0}`)
  try {
    const json = JSON.parse(text)
    console.log('  result:', JSON.stringify(json, null, 2).slice(0, 2000))
  } catch {
    console.log('  raw body (truncated):', text.slice(0, 500))
  }

  // ----- Step 2: re-run the lead-level rematch -----
  // Belt-and-suspenders: the new runMondaySync also calls this hook
  // automatically, but on commit 440f06e Vercel may not have
  // redeployed yet, so we hit the RPC directly too.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('No Supabase env — skipping direct rematch RPC.')
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })
  console.log('\nCalling rematch_monday_for_all_leads(50000) …')
  const t1 = Date.now()
  const { data, error } = await svc.rpc('rematch_monday_for_all_leads', { p_limit: 50_000 })
  if (error) {
    console.error('  rematch error:', error.message)
    return
  }
  const row = Array.isArray(data) ? (data[0] as { checked?: number; flipped?: number } | undefined) : undefined
  console.log(`  done in ${Date.now() - t1}ms — checked=${row?.checked ?? 0}, flipped=${row?.flipped ?? 0}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
