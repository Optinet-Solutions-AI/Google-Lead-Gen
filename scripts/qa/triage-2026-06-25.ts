/**
 * Triage four QA reports from 2026-06-25:
 *
 *   - "search took too long and was stopped" — what is it
 *   - batch 1654: same timeout error, multiple failed scrapes
 *   - batch 1658: heriho.de — shows not-affiliate + not-on-Monday
 *   - batch 1668: payid-pokies-australia.click — same shape
 *   - "error 3" appearing on failed scrapes
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { persistSession: false } })

  // -------- (1) failed jobs in batch 1654 + recent timeouts --------
  console.log('=== BATCH 1654: failed jobs + their error_message ===')
  const { data: batch1654 } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, status, attempts, error_message, started_at, completed_at')
    .eq('batch_id', 1654)
    .neq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(20)
  for (const j of (batch1654 ?? []) as Array<{
    id: string
    keyword: string
    country_code: string
    status: string
    attempts: number
    error_message: string | null
    started_at: string | null
    completed_at: string | null
  }>) {
    console.log(
      `  ${j.id.slice(0, 8)}  ${j.country_code}  ${j.status.padEnd(10)}  attempts=${j.attempts}  err=${(j.error_message ?? '').slice(0, 120)}`,
    )
  }

  console.log('\n=== Last 24h: distinct error_message on failed/captcha scrapes ===')
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: errs } = await svc
    .from('scrape_queue')
    .select('error_message, attempts')
    .gte('completed_at', since24)
    .in('status', ['failed', 'captcha', 'cancelled'])
    .limit(500)
  const hist = new Map<string, number>()
  for (const r of (errs ?? []) as Array<{ error_message: string | null }>) {
    const m = (r.error_message ?? '').slice(0, 120)
    hist.set(m, (hist.get(m) ?? 0) + 1)
  }
  for (const [m, n] of [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(5)}  ${m || '(no message)'}`)
  }

  // -------- (2 + 3) Mismatch leads --------
  console.log('\n=== heriho.de — DB row + replica ===')
  await diagnoseLead(svc, 'heriho.de')

  console.log('\n=== payid-pokies-australia.click — DB row + replica ===')
  await diagnoseLead(svc, 'payid-pokies-australia.click')

  // -------- (4) "error 3" on the user's UI --------
  console.log('\n=== Has "error 3" or numeric error codes anywhere in scrape_queue.error_message? ===')
  const { data: e3 } = await svc
    .from('scrape_queue')
    .select('id, keyword, error_message, completed_at, attempts')
    .or('error_message.ilike.%error 3%,error_message.ilike.%error_code%')
    .gte('completed_at', since24)
    .limit(10)
  if ((e3 ?? []).length === 0) {
    console.log('  (no matches — the "error 3" the user sees is probably the UI attempts counter, not a code)')
  } else {
    for (const j of (e3 ?? []) as Array<{ id: string; keyword: string; error_message: string | null; attempts: number }>) {
      console.log(`  ${j.id.slice(0, 8)}  attempts=${j.attempts}  ${(j.error_message ?? '').slice(0, 120)}`)
    }
  }
}

async function diagnoseLead(svc: ReturnType<typeof createClient>, domain: string) {
  // Find lead row(s) matching the domain
  const { data: leads } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, batch_id, scrape_job_id, is_affiliate, affiliate_checked_at, is_on_monday, monday_board, monday_match_kind, monday_item_id, is_not_relevant')
    .or(`domain.ilike.%${domain}%,url.ilike.%${domain}%`)
    .limit(5)
  const rows = (leads ?? []) as Array<Record<string, unknown>>
  console.log(`  Found ${rows.length} lead row(s):`)
  for (const r of rows) console.log(`    id=${r.id} batch=${r.batch_id} ${JSON.stringify(r)}`)

  // Live RPC match
  const { data: rpc, error: rpcErr } = await svc.rpc('search_website_on_monday', {
    p_domain: domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase(),
  })
  if (rpcErr) console.log(`  RPC error: ${rpcErr.message}`)
  else console.log(`  search_website_on_monday("${domain}") -> ${JSON.stringify(rpc)}`)

  // Replica scan
  const tables = ['leads_table', 'affiliates_table', 'not_relevant_leads_table', 'email_undelivered_leads_table']
  for (const tbl of tables) {
    const { data: hits } = await svc
      .from(tbl)
      .select('name, website_normalized, monday_item_id')
      .ilike('website_normalized', `%${domain}%`)
      .limit(3)
    if ((hits ?? []).length === 0) continue
    for (const h of (hits ?? []) as Array<Record<string, unknown>>) {
      console.log(`    ${tbl}: name="${h.name}" website_normalized="${h.website_normalized}" item=${h.monday_item_id}`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
