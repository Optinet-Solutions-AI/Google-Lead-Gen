/**
 * Diagnostic for Supriya's 2026-07-15 "Scrapes failing after several retries" report.
 * Two symptoms in her screenshot:
 *   - Bing NZ/AU gambling queries -> "captcha - 10 retries"
 *   - Google NZ/IE/DE gambling queries -> "failed" (Worker timed out / took too long)
 * Read-only. Groups her last-3-days jobs, inspects checkpoints + locks + pacing gates.
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

  // 1) Gates / pacing settings
  console.log('=== system settings ===')
  for (const k of [
    'captcha_solver_enabled', 'captcha_auto_solve', 'captcha_solver_ttl_minutes',
    'search_engine_cooldown_enabled', 'search_engine_cooldown_minutes',
  ]) {
    const { data, error } = await svc.rpc('get_system_setting', { p_key: k })
    console.log(`  ${k} =`, error ? `ERR ${error.message}` : JSON.stringify(data))
  }

  // 2) Supriya's recent jobs (last 3 days)
  const since = '2026-07-12'
  const { data: jobs, error } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, search_engine, status, captcha_attempts, attempts, pages, result_summary, batch_id, error_message, created_at, started_at, completed_at, created_by_display')
    .eq('created_by_display', 'Supriya')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  console.log(`\n=== Supriya jobs since ${since}: ${jobs?.length ?? 0} ===`)

  // group by engine+status
  const byGroup: Record<string, number> = {}
  for (const j of jobs ?? []) {
    const g = `${j.search_engine} / ${j.status}`
    byGroup[g] = (byGroup[g] ?? 0) + 1
  }
  console.log('--- counts by engine/status ---')
  for (const [g, n] of Object.entries(byGroup).sort((a, b) => b[1] - a[1])) console.log(`  ${g}: ${n}`)

  // 3) Detail on the stuck/failed ones
  const interesting = (jobs ?? []).filter(j =>
    ['failed', 'needs_human'].includes(j.status) ||
    (j.captcha_attempts ?? 0) >= 3)
  console.log(`\n=== detail: failed / needs_human / captcha>=3 (${interesting.length}) ===`)
  for (const j of interesting.slice(0, 40)) {
    console.log(`\n[${j.search_engine} ${j.country_code}] "${j.keyword}"  status=${j.status}`)
    console.log(`  captcha_attempts=${j.captcha_attempts} attempts=${j.attempts} pages=${j.pages} results=${JSON.stringify(j.result_summary ?? null)} batch=${j.batch_id}`)
    console.log(`  started=${j.started_at} completed=${j.completed_at}`)
    console.log(`  err=${(j.error_message ?? '').slice(0, 120)}`)
    console.log(`  id=${j.id}`)
    const { data: cps } = await svc
      .from('interactive_checkpoints')
      .select('reason, status, created_at, expires_at, resolved_at, resolved_by')
      .eq('job_id', j.id)
      .order('created_at', { ascending: true })
    if (cps?.length) {
      for (const c of cps) console.log(`    cp [${c.status}] ${c.reason} created=${c.created_at} resolved=${c.resolved_at ?? '-'} by=${c.resolved_by ?? '-'}`)
    } else {
      console.log('    cp: none')
    }
  }

  // 4) Active locks — is a dead worker holding a per-country lock?
  console.log('\n=== active_profile_locks ===')
  const { data: locks, error: lockErr } = await svc
    .from('active_profile_locks')
    .select('*')
    .order('locked_at', { ascending: true })
  if (lockErr) console.log('  lock query err:', lockErr.message)
  for (const l of locks ?? []) console.log('  ', JSON.stringify(l))
  if (!locks?.length) console.log('  (none)')
}
main().catch(e => { console.error(e); process.exit(1) })
