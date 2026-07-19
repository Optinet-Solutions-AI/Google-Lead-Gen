import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Single source of truth for scraper fleet dimensions.
 *
 * The fleet is a fixed set of EC2 VMs each running a fixed number of
 * concurrent worker slots (one browser session per slot). Edit these
 * two constants when a VM is added or removed — every capacity
 * calculation across the app reads from here.
 */
// Reduced 3 → 2 on 2026-07-17: one VM decommissioned in AWS the next
// day and the remaining two had their EBS volumes grown 29 GB → 50 GB.
// Utilization dashboard, enqueue-form load pill, queue-position ETAs,
// and every capacity calculation across the app read from here.
export const FLEET_VM_COUNT = 2
export const WORKERS_PER_VM = 9
export const FLEET_TOTAL_SLOTS = FLEET_VM_COUNT * WORKERS_PER_VM

/**
 * Live per-country concurrency cap. Backed by
 * `system_settings.max_concurrent_per_country` (default 3). Read at
 * request time so operators can dial it up without a redeploy.
 */
export async function readMaxPerCountry(): Promise<number> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', {
    p_key: 'max_concurrent_per_country',
  })
  const n = typeof data === 'number' ? data : typeof data === 'string' ? Number(data) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3
}
