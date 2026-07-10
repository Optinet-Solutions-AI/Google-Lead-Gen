/**
 * One-shot probe: hit the Enigma Customer API with ENIGMA_API_KEY, print
 * every package's used/remaining bandwidth and the summed remaining GB the
 * poller would record — then print the last 5 snapshots in
 * proxy_bandwidth_snapshots so we can compare STORED vs LIVE.
 *
 * Run locally:
 *   npx tsx scripts/qa/peek-enigma.ts
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }
  const svc = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

  console.log('===== Last 5 snapshots (newest first) =====')
  const { data: rows, error } = await svc
    .from('proxy_bandwidth_snapshots')
    .select('captured_at, used_bytes, limit_bytes, remaining_bytes, is_low, raw')
    .order('captured_at', { ascending: false })
    .limit(5)
  if (error) console.error('snapshot fetch error:', error)
  for (const r of (rows ?? []) as Array<{
    captured_at: string
    used_bytes: number
    limit_bytes: number
    remaining_bytes: number
    is_low: boolean
    raw: unknown
  }>) {
    console.log(
      `${r.captured_at}  ` +
        `used=${(r.used_bytes / BYTES_PER_GB).toFixed(2)} GB · ` +
        `limit=${(r.limit_bytes / BYTES_PER_GB).toFixed(2)} GB · ` +
        `remaining=${(r.remaining_bytes / BYTES_PER_GB).toFixed(2)} GB · ` +
        `is_low=${r.is_low}  raw=${JSON.stringify(r.raw)}`,
    )
  }

  console.log('\n===== Live Enigma Customer API =====')
  const key = process.env.ENIGMA_API_KEY
  if (!key) {
    console.error('ENIGMA_API_KEY not set in .env.local')
    process.exit(1)
  }

  type Pkg = { id?: string; product?: string; inactive?: unknown }
  type Usage = { packageId?: string; product?: string; usedBandwidth?: number; remainingBandwidth?: number }

  const packages = await enigmaGet<Pkg[]>('/api/customer/packages', key)
  console.log(`packages: ${packages.length}`)

  let totalRemaining = 0
  for (const p of packages) {
    if (!p.id) continue
    const u = await enigmaGet<Usage>(`/api/customer/packages/${p.id}`, key)
    const rem = typeof u.remainingBandwidth === 'number' ? u.remainingBandwidth : NaN
    console.log(
      `  ${p.id} [${u.product ?? p.product ?? '?'}]${p.inactive ? ' (inactive)' : ''}  ` +
        `used=${u.usedBandwidth ?? '?'} GB · remaining=${u.remainingBandwidth ?? '?'} GB`,
    )
    if (!p.inactive && Number.isFinite(rem)) totalRemaining += rem
  }

  console.log(`\nSummed remaining (active packages): ${totalRemaining.toFixed(2)} GB`)
  console.log(`→ poller would record remaining_bytes = ${Math.round(totalRemaining * BYTES_PER_GB)}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
