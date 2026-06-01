/**
 * Probe the GoLogin proxy traffic-usage endpoint so we can confirm the
 * exact response shape (field names + units — bytes vs GB) before the
 * /api/proxy/bandwidth/refresh poller relies on it.
 *
 * GoLogin docs list a "get used traffic data of gologin proxies"
 * endpoint; the OpenAPI excerpt points at
 *   GET https://api.gologin.com/users-proxies/geolocation/traffic
 * but the documented response schema is empty, so we just dump whatever
 * comes back and highlight the numeric fields that look like usage.
 *
 * Run locally (per the QA-script convention — NOT on the VM):
 *   npx tsx scripts/qa/peek-gologin-traffic.ts
 *
 * Requires GOLOGIN_API_TOKEN in .env.local (same token the VM workers
 * use — copy it from the VM's ~/.env if it isn't there yet).
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'

loadEnv({ path: join(process.cwd(), '.env.local') })

const GOLOGIN_API_URL = process.env.GOLOGIN_API_URL ?? 'https://api.gologin.com'
const TOKEN = process.env.GOLOGIN_API_TOKEN

// Candidate endpoints to try in order — the first that returns 2xx wins.
// We probe a couple because GoLogin's API has drifted across versions
// and the docs are incomplete.
const CANDIDATES = [
  '/users-proxies/geolocation/traffic',
  '/users-proxies/traffic',
  '/user/traffic',
]

async function tryEndpoint(path: string) {
  const url = `${GOLOGIN_API_URL}${path}`
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
      },
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* leave as text */
    }
    return { path, status: res.status, ok: res.ok, body }
  } catch (err) {
    return { path, status: 0, ok: false, body: err instanceof Error ? err.message : String(err) }
  }
}

/** Recursively surface numeric leaf fields whose key hints at usage. */
function highlightUsageFields(obj: unknown, prefix = ''): Array<[string, number]> {
  const hits: Array<[string, number]> = []
  const RE = /(used|left|remain|limit|total|balance|traffic|quota|bytes|gb|mb)/i
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (typeof v === 'number' && RE.test(k)) hits.push([path, v])
      else if (v && typeof v === 'object') hits.push(...highlightUsageFields(v, path))
    }
  }
  return hits
}

function asGb(n: number): string {
  // Show the value interpreted both ways so we can tell the unit at a glance.
  return `${(n / 1024 ** 3).toFixed(3)} GiB (if bytes) · ${(n / 1e9).toFixed(3)} GB (if bytes, 10^9) · ${n} raw`
}

async function main() {
  if (!TOKEN) {
    console.error('GOLOGIN_API_TOKEN is not set in .env.local.')
    console.error('Copy it from a VM ~/.env (the value after GOLOGIN_API_TOKEN=) and add it locally.')
    process.exit(1)
  }
  console.log(`GoLogin API: ${GOLOGIN_API_URL}`)
  console.log(`Token: ${TOKEN.slice(0, 8)}…${TOKEN.slice(-4)} (len ${TOKEN.length})\n`)

  for (const path of CANDIDATES) {
    const r = await tryEndpoint(path)
    const flag = r.ok ? '✓' : '✗'
    console.log(`${flag} GET ${path} → ${r.status}`)
    if (r.ok) {
      console.log('\n--- Raw response ---')
      console.log(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2))
      const hits = highlightUsageFields(r.body)
      if (hits.length) {
        console.log('\n--- Likely usage fields ---')
        for (const [k, v] of hits) console.log(`  ${k} = ${asGb(v)}`)
      } else {
        console.log('\n(no obvious usage fields found — inspect the raw response above)')
      }
      console.log('\nUse the field names above to finalise parseGoLoginTraffic() in lib/proxy-bandwidth.ts.')
      return
    } else if (typeof r.body === 'string' && r.body.length < 500) {
      console.log(`    ${r.body}`)
    }
  }
  console.error('\nNo candidate endpoint returned 2xx. Check the token, or look up the')
  console.error('current path at https://api.gologin.com/docs (Swagger) → proxy traffic.')
  process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
