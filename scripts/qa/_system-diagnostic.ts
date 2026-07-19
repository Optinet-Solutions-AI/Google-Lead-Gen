/**
 * End-of-session sanity probe. Prints a compact report card for:
 * - Fleet + workers
 * - Enigma bandwidth poller
 * - Monday mirror freshness per board
 * - Recent scrape volume & failure rate
 * - Anything hung in the queue
 *
 * Run: npx tsx scripts/qa/_system-diagnostic.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const BYTES_PER_GB = 1024 ** 3
const DAY_MS = 24 * 60 * 60 * 1000

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n===== ${title} =====`)
  try {
    await fn()
  } catch (err) {
    console.error('  ERR', err instanceof Error ? err.message : String(err))
  }
}

async function main() {
  await section('Fleet workers · active locks (right now)', async () => {
    const { data } = await supa
      .from('active_profile_locks')
      .select('country_code, job_kind, acquired_at')
      .order('acquired_at', { ascending: false })
    const rows = data ?? []
    console.log(`  ${rows.length} lock(s) held`)
    if (rows.length > 0) {
      const byCountry = new Map<string, number>()
      for (const r of rows as { country_code: string }[]) byCountry.set(r.country_code, (byCountry.get(r.country_code) ?? 0) + 1)
      for (const [c, n] of Array.from(byCountry.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${c}: ${n}`)
      }
    }
  })

  await section('Scrape queue · last 24h', async () => {
    const since = new Date(Date.now() - DAY_MS).toISOString()
    const { data } = await supa
      .from('scrape_queue')
      .select('status')
      .gte('created_at', since)
      .limit(5000)
    const rows = (data ?? []) as { status: string }[]
    const byStatus = new Map<string, number>()
    for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
    console.log(`  ${rows.length} jobs created in last 24h`)
    for (const [s, n] of Array.from(byStatus.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${s}: ${n}`)
    }
    const failed = byStatus.get('failed') ?? 0
    const total = rows.length
    if (total > 0) {
      const failRate = (failed / total) * 100
      console.log(`  Fail rate: ${failRate.toFixed(1)}%`)
    }
  })

  await section('Queue backlog · pending & running right now', async () => {
    const nowIso = new Date().toISOString()
    const [{ count: pending }, { count: running }, { count: scheduled }, { count: needsHuman }, { count: captcha }] =
      await Promise.all([
        supa
          .from('scrape_queue')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending')
          .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
          .is('parent_scrape_job_id', null),
        supa.from('scrape_queue').select('id', { count: 'exact', head: true }).eq('status', 'running').is('parent_scrape_job_id', null),
        supa.from('scrape_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending').gt('scheduled_at', nowIso).is('parent_scrape_job_id', null),
        supa.from('scrape_queue').select('id', { count: 'exact', head: true }).eq('status', 'needs_human').is('parent_scrape_job_id', null),
        supa.from('scrape_queue').select('id', { count: 'exact', head: true }).eq('status', 'captcha').is('parent_scrape_job_id', null),
      ])
    console.log(`  pending (ready): ${pending ?? 0}`)
    console.log(`  running:         ${running ?? 0}`)
    console.log(`  scheduled later: ${scheduled ?? 0}`)
    console.log(`  needs_human:     ${needsHuman ?? 0}`)
    console.log(`  captcha (stuck): ${captcha ?? 0}`)
  })

  await section('Enigma bandwidth · latest snapshot', async () => {
    const { data } = await supa
      .from('proxy_bandwidth_snapshots')
      .select('captured_at, used_bytes, remaining_bytes, limit_bytes, is_low')
      .order('captured_at', { ascending: false })
      .limit(1)
    if (!data || data.length === 0) {
      console.log('  No snapshots yet.')
      return
    }
    const s = data[0] as { captured_at: string; used_bytes: number; remaining_bytes: number; limit_bytes: number; is_low: boolean }
    const ageMin = Math.round((Date.now() - new Date(s.captured_at).getTime()) / 60_000)
    console.log(`  age:       ${ageMin} min ago (${s.captured_at})`)
    console.log(`  used:      ${(s.used_bytes / BYTES_PER_GB).toFixed(2)} GB`)
    console.log(`  remaining: ${(s.remaining_bytes / BYTES_PER_GB).toFixed(2)} GB / ${(s.limit_bytes / BYTES_PER_GB).toFixed(2)} GB plan`)
    console.log(`  is_low:    ${s.is_low}`)
  })

  await section('Monday mirror · freshness per board', async () => {
    const boards = [
      { key: 'leads', label: 'Leads', table: 'leads_table' },
      { key: 'affiliates', label: 'Affiliates', table: 'affiliates_table' },
      { key: 'not_relevant_leads', label: 'Not Relevant', table: 'not_relevant_leads_table' },
      { key: 'email_undelivered_leads', label: 'Email Undelivered', table: 'email_undelivered_leads_table' },
    ] as const
    for (const b of boards) {
      const [{ count }, latest] = await Promise.all([
        supa.from(b.table).select('id', { count: 'exact', head: true }),
        supa.from(b.table).select('synced_at').order('synced_at', { ascending: false }).limit(1),
      ])
      const iso = (latest.data?.[0] as { synced_at: string | null } | undefined)?.synced_at ?? null
      const ageMin = iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60_000) : null
      const stale = ageMin === null || ageMin > 24 * 60
      console.log(`  ${b.label.padEnd(22)} items=${(count ?? 0).toString().padStart(6)}  last_synced=${iso ?? 'never'} (${ageMin ?? '?'} min ago) ${stale ? '⚠ STALE' : 'OK'}`)
    }
  })

  await section('S-tags · mapping status', async () => {
    const [{ count: total }, { count: mapped }] = await Promise.all([
      supa.from('s_tags_table').select('id', { count: 'exact', head: true }),
      supa.from('s_tags_table').select('id', { count: 'exact', head: true }).eq('is_existing_on_monday', true),
    ])
    console.log(`  total tag rows:            ${total ?? 0}`)
    console.log(`  mapped to Monday item(s):  ${mapped ?? 0}`)
    // Unique s_tag values via SQL — do it in memory since we don't have SQL access
    const { data: sample } = await supa
      .from('s_tags_table')
      .select('s_tag')
      .not('s_tag', 'is', null)
      .order('created_at', { ascending: false })
      .limit(5000)
    const unique = new Set(((sample ?? []) as { s_tag: string }[]).map(r => r.s_tag.toLowerCase()))
    console.log(`  unique tag values (recent 5000 rows): ${unique.size}`)
  })

  await section('GoLogin profiles · active per country', async () => {
    const { data } = await supa
      .from('gologin_profiles')
      .select('country_code, is_active')
    const active = ((data ?? []) as { country_code: string; is_active: boolean }[]).filter(p => p.is_active)
    console.log(`  ${active.length} active country profile(s)`)
    console.log(`    ${active.map(p => p.country_code).sort().join(' ')}`)
  })

  await section('User caps · today', async () => {
    // What each user has submitted since UTC midnight.
    const utcMidnight = new Date()
    utcMidnight.setUTCHours(0, 0, 0, 0)
    const { data } = await supa
      .from('scrape_queue')
      .select('created_by_email')
      .gte('created_at', utcMidnight.toISOString())
      .limit(5000)
    const byUser = new Map<string, number>()
    for (const r of (data ?? []) as { created_by_email: string | null }[]) {
      const k = (r.created_by_email ?? 'unknown').toLowerCase()
      byUser.set(k, (byUser.get(k) ?? 0) + 1)
    }
    if (byUser.size === 0) {
      console.log('  no jobs enqueued today yet')
    } else {
      for (const [u, n] of Array.from(byUser.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${u.padEnd(40)} ${n}`)
      }
    }
  })
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
