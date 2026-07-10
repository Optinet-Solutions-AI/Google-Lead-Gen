/**
 * One-shot manual run of the proxy-bandwidth poll from THIS machine. Reads
 * live remaining GB from the Enigma Customer API (ENIGMA_API_KEY) and writes
 * one snapshot row so the dashboard card un-freezes immediately.
 *
 * This mirrors /api/proxy/bandwidth/refresh. Since the Customer API has no IP
 * binding, the cron poll on Vercel works the same way — this is now just a
 * convenience "refresh now" rather than the IP-workaround it used to be.
 *
 *   npx tsx scripts/qa/refresh-bandwidth-now.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const ENIGMA_API_BASE = 'https://enigmaproxy.net'
const BYTES_PER_GB = 1024 ** 3

async function enigmaGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${ENIGMA_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text) as T
}

async function main() {
  const key = process.env.ENIGMA_API_KEY
  if (!key) {
    console.error('ENIGMA_API_KEY not set in .env.local')
    process.exit(1)
  }
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const [{ data: limitRaw }, { data: thrRaw }] = await Promise.all([
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_limit_bytes' }),
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_low_threshold_bytes' }),
  ])
  const toBytes = (raw: unknown, fb: number) => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : fb
  }
  const limitBytes = toBytes(limitRaw, 5 * BYTES_PER_GB)
  const lowThreshold = toBytes(thrRaw, BYTES_PER_GB)

  type Pkg = { id?: string; inactive?: unknown }
  type Usage = { remainingBandwidth?: number }
  const packages = await enigmaGet<Pkg[]>('/api/customer/packages', key)
  let gb = 0
  let matched = false
  for (const p of packages) {
    if (!p.id || p.inactive) continue
    const u = await enigmaGet<Usage>(`/api/customer/packages/${p.id}`, key)
    if (typeof u.remainingBandwidth === 'number' && Number.isFinite(u.remainingBandwidth)) {
      gb += u.remainingBandwidth
      matched = true
    }
  }
  if (!matched) {
    console.error('No numeric remainingBandwidth from any active package.')
    process.exit(1)
  }

  const remainingBytes = Math.round(gb * BYTES_PER_GB)
  const usedBytes = Math.max(limitBytes - remainingBytes, 0)
  const isLow = remainingBytes < lowThreshold

  const { error } = await svc.from('proxy_bandwidth_snapshots').insert({
    used_bytes: usedBytes,
    limit_bytes: limitBytes,
    remaining_bytes: remainingBytes,
    is_low: isLow,
    raw: { source: 'enigma-api', remainingGb: gb, via: 'manual refresh-bandwidth-now.ts' },
  })
  if (error) {
    console.error('Insert failed:', error.message)
    process.exit(1)
  }
  console.log(
    `Wrote snapshot: remaining ${gb.toFixed(2)} GB / limit ${(limitBytes / BYTES_PER_GB).toFixed(0)} GB ` +
      `(used ${(usedBytes / BYTES_PER_GB).toFixed(2)} GB, low=${isLow}). Card is now fresh & consistent.`,
  )
}

main().catch(e => { console.error(e); process.exit(1) })
