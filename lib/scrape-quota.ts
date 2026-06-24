import 'server-only'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Per-user daily scrape quota.
 *
 * Operators each get up to N scrape-queue rows per UTC day (default
 * 20, configurable via system_settings.daily_scrape_cap_per_user).
 * Bypass is gated on user_profiles.bypass_scrape_cap — independent
 * of is_admin so working admins (Charisse, Hannah, etc.) still get
 * the cap; only the dedicated "Admin" service account is exempt
 * out of the box.
 *
 * One "scrape" = one row in scrape_queue (i.e. one keyword × engine
 * combo). A batch of 50 keywords on engine=both is 100 rows. The
 * count rolls over at UTC midnight to keep timezone math simple
 * and predictable.
 */

const DEFAULT_CAP = 20

export type QuotaSnapshot = {
  /** Configured cap, or null when bypass_scrape_cap or caps disabled. */
  cap: number | null
  /** Rows the user has queued since UTC midnight. */
  usedToday: number
  /** cap - usedToday, clamped to 0. null when exempt / cap disabled. */
  remaining: number | null
  /** Whether the caller is exempt (bypass_scrape_cap=true or cap=0). */
  exempt: boolean
}

/** Read the cap setting; null when caps are disabled (0). */
async function readCap(): Promise<number | null> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', {
    p_key: 'daily_scrape_cap_per_user',
  })
  const n = typeof data === 'number' ? data : typeof data === 'string' ? Number(data) : DEFAULT_CAP
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

/**
 * Snapshot of the current viewer's quota — used by the EnqueueForm
 * to display "Scrapes today: X/Y" and by the server actions to
 * gate inserts.
 */
export async function getQuotaForCurrentUser(): Promise<QuotaSnapshot> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { cap: null, usedToday: 0, remaining: null, exempt: true }

  const svc = createServiceClient()
  // Bypass gate — reads the dedicated bypass_scrape_cap column rather
  // than is_admin, so working admins still hit the cap while only the
  // service "Admin" account (seeded true in migration 20260627000000)
  // is exempt out of the box.
  const { data: bypassRow } = await svc
    .from('user_profiles')
    .select('bypass_scrape_cap')
    .eq('id', user.id)
    .maybeSingle()
  const bypass = (bypassRow as { bypass_scrape_cap: boolean | null } | null)?.bypass_scrape_cap === true
  if (bypass) {
    return { cap: null, usedToday: 0, remaining: null, exempt: true }
  }

  const cap = await readCap()
  if (cap === null) {
    return { cap: null, usedToday: 0, remaining: null, exempt: true }
  }

  const email = (user.email ?? '').toLowerCase()
  const { data: usedRaw } = await svc.rpc('count_user_scrapes_today', { p_email: email })
  const used = typeof usedRaw === 'number' ? usedRaw : 0
  const remaining = Math.max(cap - used, 0)
  return { cap, usedToday: used, remaining, exempt: false }
}

/**
 * Server-side guard for enqueue paths. Pass the number of rows about
 * to be inserted. Returns `{ ok: true }` when the insert fits inside
 * the remaining quota (or the caller is exempt). Returns `{ ok:
 * false, error }` with a friendly message otherwise.
 */
export async function checkQuota(
  requested: number,
): Promise<
  | { ok: true; remaining_after: number | null }
  | { ok: false; error: string; cap: number; usedToday: number; remaining: number }
> {
  const snap = await getQuotaForCurrentUser()
  if (snap.exempt || snap.cap === null || snap.remaining === null) {
    return { ok: true, remaining_after: null }
  }
  if (requested <= 0) return { ok: true, remaining_after: snap.remaining }
  if (requested > snap.remaining) {
    return {
      ok: false,
      error:
        `Daily scrape cap reached — you've queued ${snap.usedToday}/${snap.cap} today ` +
        `and this submit would add ${requested} more. ` +
        `${snap.remaining > 0 ? `You can still queue ${snap.remaining} ` + (snap.remaining === 1 ? 'scrape' : 'scrapes') + '.' : 'Try again after UTC midnight or ask an admin.'}`,
      cap: snap.cap,
      usedToday: snap.usedToday,
      remaining: snap.remaining,
    }
  }
  return { ok: true, remaining_after: snap.remaining - requested }
}
