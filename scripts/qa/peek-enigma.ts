/**
 * One-shot probe: fetch the Enigma dashboard with our session cookie,
 * print every "N GB"-shaped match the parser would see, and show what
 * fetchEnigmaBandwidth would return — then print the last 5 snapshots
 * in proxy_bandwidth_snapshots so we can compare what's STORED vs what
 * Enigma is reporting RIGHT NOW.
 *
 * Run locally:
 *   npx tsx scripts/qa/peek-enigma.ts
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const ENIGMA_DASHBOARD_URL = 'https://enigmaproxy.net/dashboard'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const BYTES_PER_GB = 1024 ** 3

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

  console.log('\n===== Live Enigma fetch =====')
  const cookie = process.env.ENIGMA_COOKIE
  if (!cookie) {
    console.error('ENIGMA_COOKIE not set in .env.local')
    process.exit(1)
  }
  const res = await fetch(ENIGMA_DASHBOARD_URL, {
    headers: { Cookie: `__session=${cookie}`, 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    redirect: 'manual',
  })
  console.log('status:', res.status, res.statusText)
  if (res.status >= 300 && res.status < 400) {
    console.log('redirected to:', res.headers.get('location'))
    process.exit(1)
  }
  const html = await res.text()
  console.log('html length:', html.length)

  const PARSER_RE = /(\d+(?:\.\d+)?)\s*<!--\s*-->\s*GB/gi
  const parserMatches = [...html.matchAll(PARSER_RE)].map(m => parseFloat(m[1] ?? ''))
  console.log('\nCurrent parser matches:', parserMatches)
  console.log('Sum:', parserMatches.reduce((a, b) => a + b, 0), 'GB')

  const ALL_GB = /([\s\S]{0,80})(\d+(?:\.\d+)?)\s*(?:<[^>]*>\s*)*GB/gi
  console.log('\nAll "N GB" hits (with 80 chars left-context):')
  let i = 0
  for (const m of html.matchAll(ALL_GB)) {
    i += 1
    if (i > 30) {
      console.log('  ... (truncated to 30)')
      break
    }
    const ctx = (m[1] ?? '').replace(/\s+/g, ' ').slice(-60)
    console.log(`  [${i}] ...${ctx}>> ${m[2]} GB`)
  }

  const firstGb = html.search(/\bGB\b/i)
  if (firstGb >= 0) {
    const start = Math.max(0, firstGb - 200)
    const end = Math.min(html.length, firstGb + 80)
    console.log('\nMarkup chunk around first GB (raw):')
    console.log(html.slice(start, end))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
