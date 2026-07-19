import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import {
  FLEET_TOTAL_SLOTS,
  FLEET_VM_COUNT,
  WORKERS_PER_VM,
  readMaxPerCountry,
} from '@/lib/fleet'

export { FLEET_TOTAL_SLOTS, FLEET_VM_COUNT, WORKERS_PER_VM }

const DAY_MS = 24 * 60 * 60 * 1000

async function readDailyCap(): Promise<number | null> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', { p_key: 'daily_scrape_cap_per_user' })
  const n = typeof data === 'number' ? data : typeof data === 'string' ? Number(data) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

export type ActiveLock = {
  country_code: string
  job_kind: string | null
  ageMinutes: number
}

export type DailyCount = { dateIso: string; count: number }

export type CountryCount = { country_code: string; count: number; pct: number }

export type UserDayCount = { dateIso: string; count: number; overCap: boolean }
export type UserRollup = {
  email: string
  bypass: boolean
  isAdmin: boolean
  total7d: number
  byDay: UserDayCount[]
  peak: number
  hitCap: boolean
}

export type UtilizationData = {
  generatedAt: string
  fleet: {
    vmCount: number
    workersPerVm: number
    totalSlots: number
    maxPerCountry: number
    activeLocks: ActiveLock[]
    slotsInUse: number
    utilizationPct: number
    /** Rows in status='pending' AND ready to run (schedule already passed). */
    pendingReady: number
    /** Rows in status='pending' but scheduled for later. Parked, not queued. */
    scheduledLater: number
  }
  jobs: {
    startedLast24h: number
    completedLast24h: number
    avgDurationSec: number | null
    maxDurationSec: number | null
    theoreticalJobsPerHourPerVm: number
    theoreticalJobsPerHourFleet: number
  }
  daily: {
    days14: DailyCount[]
    total14d: number
    peakDay: DailyCount | null
    avgPerDay: number
  }
  countries: {
    total14d: number
    breakdown: CountryCount[]
  }
  users: {
    dailyCap: number | null
    rollup7d: UserRollup[]
  }
}

export async function loadUtilizationData(): Promise<UtilizationData> {
  const svc = createServiceClient()
  const now = Date.now()
  const since24h = new Date(now - DAY_MS).toISOString()
  const since14 = new Date(now - 14 * DAY_MS).toISOString()
  const since7 = new Date(now - 7 * DAY_MS).toISOString()

  const nowIso = new Date(now).toISOString()

  const [
    { data: locks },
    { data: started24h },
    { data: rows14d },
    { count: pendingReady },
    { count: scheduledLater },
    maxPerCountry,
    dailyCap,
    { data: profiles },
  ] = await Promise.all([
    svc
      .from('active_profile_locks')
      .select('country_code, job_kind, acquired_at')
      .order('acquired_at', { ascending: false }),
    svc
      .from('scrape_queue')
      .select('country_code, status, started_at, completed_at')
      .gte('created_at', since24h)
      .not('started_at', 'is', null)
      .limit(2000),
    svc
      .from('scrape_queue')
      .select('created_at, country_code, created_by_email')
      .gte('created_at', since14)
      .order('created_at', { ascending: false })
      .limit(10_000),
    svc
      .from('scrape_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
      .is('parent_scrape_job_id', null),
    svc
      .from('scrape_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .gt('scheduled_at', nowIso)
      .is('parent_scrape_job_id', null),
    readMaxPerCountry(),
    readDailyCap(),
    svc.from('user_profiles').select('email, is_admin, bypass_scrape_cap'),
  ])

  // ------ Fleet + locks
  type LockRow = { country_code: string; job_kind: string | null; acquired_at: string }
  const activeLocks: ActiveLock[] = ((locks as LockRow[] | null) ?? []).map(l => ({
    country_code: l.country_code,
    job_kind: l.job_kind,
    ageMinutes: Math.round((now - new Date(l.acquired_at).getTime()) / 60_000),
  }))
  const slotsInUse = activeLocks.length
  const utilizationPct = FLEET_TOTAL_SLOTS > 0 ? (slotsInUse / FLEET_TOTAL_SLOTS) * 100 : 0
  const pendingReadyCount = pendingReady ?? 0
  const scheduledLaterCount = scheduledLater ?? 0

  // ------ Job durations (last 24h)
  type StartedRow = { status: string | null; started_at: string | null; completed_at: string | null }
  const started = (started24h as StartedRow[] | null) ?? []
  const startedCount = started.length
  const completed = started.filter(r => r.status === 'completed' && r.completed_at)
  const durationsSec = completed
    .map(r => (new Date(r.completed_at!).getTime() - new Date(r.started_at!).getTime()) / 1000)
    .filter(d => d > 0 && d < 60 * 60 * 6) // discard obvious outliers (>6h)
  const avgDurationSec = durationsSec.length
    ? Math.round(durationsSec.reduce((s, d) => s + d, 0) / durationsSec.length)
    : null
  const maxDurationSec = durationsSec.length ? Math.round(Math.max(...durationsSec)) : null
  // Theoretical throughput: 3600s / avg-duration, per worker slot.
  const perSlotPerHour = avgDurationSec && avgDurationSec > 0 ? 3600 / avgDurationSec : 0
  const theoreticalJobsPerHourPerVm = Math.round(perSlotPerHour * WORKERS_PER_VM)
  const theoreticalJobsPerHourFleet = Math.round(perSlotPerHour * FLEET_TOTAL_SLOTS)

  // ------ Last-14-days daily counts
  type QueueRow = { created_at: string; country_code: string; created_by_email: string | null }
  const rows = (rows14d as QueueRow[] | null) ?? []
  const byDay = new Map<string, number>()
  const byCountry = new Map<string, number>()
  for (const r of rows) {
    const d = r.created_at.slice(0, 10)
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
    byCountry.set(r.country_code, (byCountry.get(r.country_code) ?? 0) + 1)
  }
  const days14: DailyCount[] = []
  for (let i = 13; i >= 0; i--) {
    const iso = new Date(now - i * DAY_MS).toISOString().slice(0, 10)
    days14.push({ dateIso: iso, count: byDay.get(iso) ?? 0 })
  }
  const total14d = rows.length
  const peakDay = days14.reduce<DailyCount | null>(
    (best, d) => (best === null || d.count > best.count ? d : best),
    null,
  )
  const avgPerDay = days14.length ? total14d / days14.length : 0

  const breakdown: CountryCount[] = Array.from(byCountry.entries())
    .map(([country_code, count]) => ({
      country_code,
      count,
      pct: total14d > 0 ? (count / total14d) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count)

  // ------ Per-user, last 7d
  type ProfileRow = { email: string | null; is_admin: boolean | null; bypass_scrape_cap: boolean | null }
  const profByEmail = new Map<string, { isAdmin: boolean; bypass: boolean }>()
  for (const p of (profiles as ProfileRow[] | null) ?? []) {
    const e = (p.email ?? '').toLowerCase()
    if (e) profByEmail.set(e, { isAdmin: p.is_admin === true, bypass: p.bypass_scrape_cap === true })
  }
  const rows7 = rows.filter(r => r.created_at >= since7)
  const perUser = new Map<string, Map<string, number>>()
  for (const r of rows7) {
    const u = (r.created_by_email ?? 'unknown').toLowerCase()
    const d = r.created_at.slice(0, 10)
    if (!perUser.has(u)) perUser.set(u, new Map())
    const inner = perUser.get(u)!
    inner.set(d, (inner.get(d) ?? 0) + 1)
  }
  const rollup7d: UserRollup[] = []
  for (const [email, days] of perUser.entries()) {
    const info = profByEmail.get(email) ?? { isAdmin: false, bypass: false }
    const byDayArr: UserDayCount[] = []
    let peak = 0
    let hitCap = false
    let total = 0
    for (let i = 6; i >= 0; i--) {
      const iso = new Date(now - i * DAY_MS).toISOString().slice(0, 10)
      const count = days.get(iso) ?? 0
      const overCap = dailyCap !== null && !info.bypass && count >= dailyCap
      if (overCap) hitCap = true
      if (count > peak) peak = count
      total += count
      byDayArr.push({ dateIso: iso, count, overCap })
    }
    rollup7d.push({
      email,
      bypass: info.bypass,
      isAdmin: info.isAdmin,
      total7d: total,
      byDay: byDayArr,
      peak,
      hitCap,
    })
  }
  rollup7d.sort((a, b) => b.total7d - a.total7d)

  return {
    generatedAt: new Date().toISOString(),
    fleet: {
      vmCount: FLEET_VM_COUNT,
      workersPerVm: WORKERS_PER_VM,
      totalSlots: FLEET_TOTAL_SLOTS,
      maxPerCountry,
      activeLocks,
      slotsInUse,
      utilizationPct,
      pendingReady: pendingReadyCount,
      scheduledLater: scheduledLaterCount,
    },
    jobs: {
      startedLast24h: startedCount,
      completedLast24h: completed.length,
      avgDurationSec,
      maxDurationSec,
      theoreticalJobsPerHourPerVm,
      theoreticalJobsPerHourFleet,
    },
    daily: {
      days14,
      total14d,
      peakDay,
      avgPerDay,
    },
    countries: {
      total14d,
      breakdown,
    },
    users: {
      dailyCap,
      rollup7d,
    },
  }
}
