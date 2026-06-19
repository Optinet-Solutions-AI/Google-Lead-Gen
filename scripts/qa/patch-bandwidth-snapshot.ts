/**
 * Stop-gap: insert a single proxy_bandwidth_snapshots row with the
 * operator-reported remaining GB so the dashboard reflects reality
 * immediately, without waiting for the next poll. The next scheduled
 * cron tick will overwrite it with whatever Enigma actually returns.
 *
 * Run locally:
 *   REMAINING_GB=11.67 npx tsx scripts/qa/patch-bandwidth-snapshot.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const BYTES_PER_GB = 1024 ** 3

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }
  const remainingGb = Number(process.env.REMAINING_GB)
  if (!Number.isFinite(remainingGb) || remainingGb < 0) {
    console.error('Set REMAINING_GB to a non-negative number (e.g. REMAINING_GB=11.67).')
    process.exit(1)
  }
  const svc = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

  const [{ data: limitRaw }, { data: thresholdRaw }] = await Promise.all([
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_limit_bytes' }),
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_low_threshold_bytes' }),
  ])
  const toBytes = (raw: unknown, fallback: number) => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const limitBytes = toBytes(limitRaw, 15 * BYTES_PER_GB)
  const lowThreshold = toBytes(thresholdRaw, BYTES_PER_GB)

  const remainingBytes = Math.round(remainingGb * BYTES_PER_GB)
  const usedBytes = Math.max(limitBytes - remainingBytes, 0)
  const isLow = remainingBytes < lowThreshold

  const { error } = await svc.from('proxy_bandwidth_snapshots').insert({
    used_bytes: usedBytes,
    limit_bytes: limitBytes,
    remaining_bytes: remainingBytes,
    is_low: isLow,
    raw: { source: 'operator_patch', remainingGb, note: 'manual stop-gap' },
  })
  if (error) {
    console.error('insert failed:', error)
    process.exit(1)
  }
  console.log(
    `Inserted: remaining ${remainingGb} GB · limit ${(limitBytes / BYTES_PER_GB).toFixed(2)} GB · is_low=${isLow}`,
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
