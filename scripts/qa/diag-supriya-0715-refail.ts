import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
loadEnv({ path: join(process.cwd(), '.env.local') })
async function main() {
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })
  // The 4 jobs in her latest screenshot (by keyword+country, Google), newest first
  const specs = [
    ['$20 paysafecard deposit bonus casino nz', 'NZ'],
    ['ireland casino', 'IE'],
    ['new casino sites', 'IE'],
    ['online casino ireland', 'IE'],
    ['neue online casinos', 'DE'],
  ] as const
  for (const [kw, cc] of specs) {
    const { data: jobs } = await svc
      .from('scrape_queue')
      .select('id,keyword,country_code,status,attempts,max_attempts,captcha_attempts,claimed_by,error_message,created_at,started_at,completed_at,updated_at')
      .eq('country_code', cc).ilike('keyword', kw)
      .order('updated_at', { ascending: false }).limit(2)
    for (const j of jobs ?? []) {
      console.log(`\n[${j.country_code}] "${j.keyword}"  status=${j.status}  att=${j.attempts}/${j.max_attempts} capt=${j.captcha_attempts}`)
      console.log(`  claimed_by=${j.claimed_by ?? '-'} started=${j.started_at} completed=${j.completed_at} updated=${j.updated_at}`)
      console.log(`  err=${(j.error_message ?? '').slice(0,150)}`)
      console.log(`  id=${j.id}`)
      const { data: cps } = await svc.from('interactive_checkpoints')
        .select('reason,status,created_at,expires_at,resolved_at,resolved_by').eq('job_id', j.id).order('created_at')
      for (const c of cps ?? []) console.log(`    cp [${c.status}] ${c.reason} created=${c.created_at} exp=${c.expires_at} resolved=${c.resolved_at ?? '-'} by=${c.resolved_by ?? '-'}`)
      if (!cps?.length) console.log('    cp: none')
    }
  }
  const { data: locks } = await svc.from('active_profile_locks').select('*').order('locked_at')
  console.log(`\n=== active locks: ${locks?.length ?? 0} ===`)
  for (const l of locks ?? []) console.log('  ', l.country_code, l.worker_id, l.locked_at, l.job_id)
}
main().catch(e => { console.error(e); process.exit(1) })
