import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { persistSession: false } })

  console.log('=== Distinct error_messages on recent failed affiliate fetches ===')
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
  const { data: failed } = await svc
    .from('enrichment_fetch_queue')
    .select('error_message, attempts')
    .eq('status', 'failed')
    .gte('updated_at', since)
    .limit(2000)
  const messages = new Map<string, number>()
  for (const r of (failed ?? []) as Array<{ error_message: string | null; attempts: number }>) {
    const msg = (r.error_message ?? '').slice(0, 120)
    messages.set(msg, (messages.get(msg) ?? 0) + 1)
  }
  const sorted = [...messages.entries()].sort((a, b) => b[1] - a[1])
  for (const [msg, n] of sorted.slice(0, 15)) {
    console.log(`  ${String(n).padStart(5)}  ${msg || '(no message)'}`)
  }

  console.log('\n=== Sample attempts distribution on failed rows ===')
  const attHisto = new Map<number, number>()
  for (const r of (failed ?? []) as Array<{ error_message: string | null; attempts: number }>) {
    attHisto.set(r.attempts, (attHisto.get(r.attempts) ?? 0) + 1)
  }
  for (const [a, n] of [...attHisto.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  attempts=${a}  count=${n}`)
  }

  console.log('\n=== Stuck job 9b0ddd99 — full per-lead affiliate-stage breakdown ===')
  const fullId = '9b0ddd99'
  const { data: stuckOne } = await svc
    .from('scrape_queue')
    .select('id')
    .like('id', `${fullId}%`)
    .limit(1)
    .maybeSingle()
  if (stuckOne) {
    const jobId = (stuckOne as { id: string }).id
    const { data: leads } = await svc
      .from('google_lead_gen_table')
      .select('id, affiliate_checked_at, is_on_monday, is_not_relevant')
      .eq('scrape_job_id', jobId)
    const ls = (leads ?? []) as Array<{
      id: number
      affiliate_checked_at: string | null
      is_on_monday: boolean | null
      is_not_relevant: boolean | null
    }>
    console.log(`Job ${jobId} has ${ls.length} leads`)
    const needsAff = ls.filter(
      l => l.is_on_monday !== true && l.is_not_relevant !== true && !l.affiliate_checked_at,
    )
    console.log(`Leads not on Monday + not not-relevant + missing affiliate_checked_at: ${needsAff.length}`)
    if (needsAff.length > 0) {
      console.log('First 5 such leads:')
      for (const l of needsAff.slice(0, 5)) console.log(`  ${l.id}`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
