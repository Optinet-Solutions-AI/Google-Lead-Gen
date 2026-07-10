import type { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireBearer } from '@/lib/auth/bearer'
import { fetchEnigmaBandwidth, BYTES_PER_GB } from '@/lib/proxy-bandwidth'

// Vercel cron sends GET — alias to the POST handler.
export async function GET(request: NextRequest) {
  return POST(request)
}

/**
 * Reads remaining proxy bandwidth from Enigma (the metered residential
 * plan our scrapes actually run through) and writes one snapshot row to
 * proxy_bandwidth_snapshots. Called by Vercel cron (see vercel.json) and
 * reusable as a manual POST. Secured by the shared CRON_SECRET bearer
 * token, same as /api/scheduler/tick.
 *
 * Enigma reports remaining only (via its Customer API, authed by the
 * ENIGMA_API_KEY bearer key). We pair that with the admin-configured plan
 * size (system_settings.proxy_bandwidth_limit_bytes) to derive used and
 * the progress bar. If the key is missing/invalid the fetch throws, no
 * snapshot is written, and the dashboard card goes stale until it's fixed.
 *
 * On the not-low → low transition we drop a row into activity_log so the
 * dashboard's Recent activity surfaces the warning (email dispatch isn't
 * built in this app yet; the in-app banner + this entry are the alert).
 */
export async function POST(request: NextRequest) {
  const check = requireBearer(
    request.headers.get('authorization'),
    process.env.CRON_SECRET,
    { secretName: 'CRON_SECRET' },
  )
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })

  const svc = createServiceClient()

  // ----- Config -----
  const [{ data: limitRaw }, { data: thresholdRaw }] = await Promise.all([
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_limit_bytes' }),
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_low_threshold_bytes' }),
  ])
  const configuredLimit = toBytes(limitRaw, 5 * BYTES_PER_GB)
  const lowThreshold = toBytes(thresholdRaw, BYTES_PER_GB)

  // ----- Pull remaining bandwidth from Enigma -----
  let traffic
  try {
    traffic = await fetchEnigmaBandwidth()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[proxy/bandwidth/refresh] Enigma fetch failed:', message)
    return Response.json({ ok: false, error: message }, { status: 502 })
  }

  // ----- Reconcile to (used, limit, remaining) in bytes -----
  const limitBytes = traffic.limitBytes ?? configuredLimit
  let usedBytes = traffic.usedBytes
  let remainingBytes = traffic.remainingBytes
  if (usedBytes === null && remainingBytes !== null) usedBytes = Math.max(limitBytes - remainingBytes, 0)
  if (remainingBytes === null) remainingBytes = Math.max(limitBytes - (usedBytes ?? 0), 0)
  if (usedBytes === null) usedBytes = Math.max(limitBytes - remainingBytes, 0)

  const isLow = remainingBytes < lowThreshold

  // ----- Was the previous snapshot already low? (transition detection) -----
  const { data: prev } = await svc
    .from('proxy_bandwidth_snapshots')
    .select('is_low')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const wasLow = (prev as { is_low?: boolean } | null)?.is_low ?? false

  // ----- Write the snapshot -----
  const { error: insErr } = await svc.from('proxy_bandwidth_snapshots').insert({
    used_bytes: usedBytes,
    limit_bytes: limitBytes,
    remaining_bytes: remainingBytes,
    is_low: isLow,
    raw: (traffic.raw ?? null) as Record<string, unknown> | null,
  })
  if (insErr) {
    console.error('[proxy/bandwidth/refresh] snapshot insert failed:', insErr.message)
    return Response.json({ ok: false, error: insErr.message }, { status: 500 })
  }

  // ----- Alert on the not-low → low transition -----
  if (isLow && !wasLow) {
    await svc.from('activity_log').insert({
      user_id: null,
      user_email: null,
      user_is_shadow: false,
      action: 'proxy_bandwidth.low',
      entity_type: 'proxy_bandwidth',
      entity_id: null,
      details: {
        remaining_bytes: remainingBytes,
        limit_bytes: limitBytes,
        threshold_bytes: lowThreshold,
      },
    })
    console.warn(
      `[proxy/bandwidth/refresh] LOW: ${(remainingBytes / BYTES_PER_GB).toFixed(2)} GB left ` +
        `(threshold ${(lowThreshold / BYTES_PER_GB).toFixed(2)} GB)`,
    )
  }

  return Response.json({
    ok: true,
    used_bytes: usedBytes,
    limit_bytes: limitBytes,
    remaining_bytes: remainingBytes,
    is_low: isLow,
    transitioned_to_low: isLow && !wasLow,
  })
}

/** Coerce a jsonb setting (number, or numeric string) to bytes. */
function toBytes(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}
