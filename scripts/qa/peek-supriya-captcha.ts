/**
 * One-off: pull Supriya's flagged scrape + any of her recent captcha-state
 * scrapes so we can answer the QA question "how do I fix a captcha if I
 * missed the error notification?" with real data.
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

  const flaggedId = 'fbe92f2e-a64b-4bcd-925d-0778aa22ad69'
  const { data: one, error: oneErr } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, search_engine, status, captcha_attempts, attempts, error_message, started_at, completed_at, created_by_display',
    )
    .eq('id', flaggedId)
    .maybeSingle()
  if (oneErr) throw oneErr
  console.log('--- Flagged scrape ---')
  console.log(JSON.stringify(one, null, 2))

  const { data: list, error: listErr } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, search_engine, status, captcha_attempts, attempts, error_message, completed_at, created_by_display',
    )
    .eq('created_by_display', 'Supriya')
    .eq('status', 'captcha')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(10)
  if (listErr) throw listErr
  console.log(`\n--- Supriya's captcha-status scrapes (${list?.length ?? 0}) ---`)
  for (const r of list ?? []) {
    console.log(JSON.stringify(r, null, 2))
  }

  // Also look up checkpoint rows for the flagged job — if HITL was on,
  // there should be a row in interactive_checkpoints.
  const { data: cps, error: cpErr } = await svc
    .from('interactive_checkpoints')
    .select('id, reason, status, created_at, expires_at, resolved_at, resolved_by')
    .eq('job_id', flaggedId)
  if (cpErr) throw cpErr
  console.log(`\n--- interactive_checkpoints for flagged job (${cps?.length ?? 0}) ---`)
  for (const c of cps ?? []) {
    console.log(JSON.stringify(c, null, 2))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
