import 'server-only'

/**
 * Proxy bandwidth helpers — read remaining proxy data from the metered
 * plan that actually carries our scrapes.
 *
 * ACTIVE SOURCE: Enigma (resi.enigmaproxy.net). The GoLogin profiles
 * route through Enigma residential proxies on a metered plan that Chris
 * tops up (the "15 GB"). We read the balance from Enigma's Customer API
 * (bearer `epk_…` key in ENIGMA_API_KEY) — see fetchEnigmaBandwidth below.
 * This replaced an earlier cookie-scraping approach that broke when Enigma
 * moved to a Cloudflare-fronted SPA with IP-bound sessions.
 *
 * SECONDARY SOURCE: GoLogin's own datacenter traffic API
 * (fetchGoLoginTraffic). This tracks a *different*, barely-used proxy
 * pool and is kept for reference / possible future use — the poller does
 * NOT use it. Run `npx tsx scripts/qa/peek-gologin-traffic.ts` to probe
 * it.
 *
 * Both fetchers return the same ProxyTraffic shape so the poller
 * (/api/proxy/bandwidth/refresh) is source-agnostic.
 */

export const BYTES_PER_GB = 1024 ** 3

const GOLOGIN_API_URL = process.env.GOLOGIN_API_URL ?? 'https://api.gologin.com'

// GoLogin's API has drifted across versions and the docs don't pin the
// traffic path, so we try a few. First 2xx wins.
const TRAFFIC_ENDPOINTS = [
  '/users-proxies/geolocation/traffic',
  '/users-proxies/traffic',
  '/user/traffic',
]

export type ProxyTraffic = {
  /** Bytes consumed, or null if the source didn't expose it. */
  usedBytes: number | null
  /** Plan allowance in bytes if the source reports it, else null. */
  limitBytes: number | null
  /** Bytes remaining if the source reports it directly, else null. */
  remainingBytes: number | null
  /** The raw parsed response (or text), kept for debugging. */
  raw: unknown
}

/** Walk an object tree collecting numeric leaves keyed by dotted path. */
function numericLeaves(obj: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (typeof v === 'number' && Number.isFinite(v)) out[path] = v
      else if (v && typeof v === 'object') numericLeaves(v, path, out)
    }
  }
  return out
}

/**
 * Pull used / limit (in bytes) out of a GoLogin traffic response.
 *
 * The real response (confirmed via scripts/qa/peek-gologin-traffic.ts)
 * splits traffic into per-proxy-type buckets, each carrying byte-precise
 * fields:
 *   {
 *     mobileTrafficData:     { trafficUsedBytes, trafficLimitBytes, ... },
 *     residentTrafficData:   { ... },
 *     dataCenterTrafficData: { trafficUsedBytes: 309265088, trafficLimitBytes: 524288000 },
 *     deviceTrafficData:     { ... },
 *     prices: {...}, bundlePrices: {...}   // ignored
 *   }
 * We want a single shared pool, so we SUM trafficUsedBytes /
 * trafficLimitBytes across every "*TrafficData" bucket. remaining is left
 * null here — the poller computes limit − used so the fallback plan size
 * can stand in when GoLogin reports no limit.
 *
 * Falls back to a generic field-name scan if the bucket shape ever
 * changes, so a future API tweak degrades instead of breaking.
 */
export function parseGoLoginTraffic(raw: unknown): Omit<ProxyTraffic, 'raw'> {
  if (raw && typeof raw === 'object') {
    let usedSum = 0
    let limitSum = 0
    let matched = false
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (!/TrafficData$/.test(key) || !val || typeof val !== 'object') continue
      const bucket = val as Record<string, unknown>
      const used = bucket.trafficUsedBytes
      const limit = bucket.trafficLimitBytes
      if (typeof used === 'number' || typeof limit === 'number') {
        matched = true
        if (typeof used === 'number') usedSum += used
        if (typeof limit === 'number') limitSum += limit
      }
    }
    if (matched) {
      return {
        usedBytes: usedSum,
        // A zero total limit means "no plan reported" — return null so the
        // poller falls back to the admin-configured plan size rather than
        // treating the pool as a 0-byte (always-low) plan.
        limitBytes: limitSum > 0 ? limitSum : null,
        remainingBytes: null,
      }
    }
  }

  // ---- Fallback: generic leaf-name scan (older/unknown shapes) ----
  const leaves = numericLeaves(raw)
  const find = (patterns: RegExp[]): number | null => {
    for (const re of patterns) {
      for (const [key, val] of Object.entries(leaves)) {
        const leaf = key.split('.').pop() ?? key
        if (re.test(leaf)) return val
      }
    }
    return null
  }
  return {
    usedBytes: find([/^used(bytes|traffic|data)?$/i, /traffic.?used/i, /used/i]),
    limitBytes: find([/^(limit|total|plan|quota)(bytes|traffic|data)?$/i, /traffic.?(limit|total)/i]),
    remainingBytes: find([/^(left|remaining|remain|balance)(bytes|traffic|data)?$/i, /(left|remaining|balance)/i]),
  }
}

/**
 * Call GoLogin and return parsed traffic usage. Throws on missing token
 * or when no endpoint returns a usable response — the caller (the
 * poller route) catches and reports it so a GoLogin outage never writes
 * a bogus snapshot.
 */
export async function fetchGoLoginTraffic(): Promise<ProxyTraffic> {
  const token = process.env.GOLOGIN_API_TOKEN
  if (!token) {
    throw new Error('GOLOGIN_API_TOKEN is not set — add it to the deployment env.')
  }

  let lastStatus = 0
  let lastBody = ''
  for (const path of TRAFFIC_ENDPOINTS) {
    let res: Response
    try {
      res = await fetch(`${GOLOGIN_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        // Don't let a hung GoLogin call stall the whole cron tick.
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      lastBody = err instanceof Error ? err.message : String(err)
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      lastStatus = res.status
      lastBody = text.slice(0, 300)
      continue
    }
    let raw: unknown = text
    try {
      raw = JSON.parse(text)
    } catch {
      /* leave as text — parse will just find nothing */
    }
    const parsed = parseGoLoginTraffic(raw)
    if (parsed.usedBytes === null && parsed.remainingBytes === null) {
      // 2xx but no recognisable usage fields — treat as a shape problem
      // rather than silently writing nulls.
      throw new Error(
        `GoLogin ${path} returned 200 but no recognisable usage fields. ` +
          `Run scripts/qa/peek-gologin-traffic.ts and update parseGoLoginTraffic.`,
      )
    }
    return { ...parsed, raw }
  }
  throw new Error(
    `GoLogin traffic endpoint unreachable (last status ${lastStatus || 'n/a'}: ${lastBody || 'no response'}).`,
  )
}

// ---------------------------------------------------------------------------
// Enigma (active source) — read remaining GB from the Customer API.
// ---------------------------------------------------------------------------
//
// History: this used to scrape the logged-in dashboard HTML with a copied
// `__session` cookie. That broke for good when Enigma migrated to a
// Cloudflare-fronted Remix SPA whose session is IP-bound — a cookie copied
// from a browser could not be replayed from Vercel's rotating IPs, so the
// poller silently wrote no real snapshot for weeks (PMS: "auto-poller dead").
//
// Enigma has since shipped a proper **Customer API** (enable it under
// Dashboard → Customer API to mint an `epk_…` key). It is a plain
// bearer-authenticated JSON API with no cookie, no Cloudflare challenge and
// no IP binding, so it works from anywhere including serverless. It is
// undocumented publicly (the docs subdomain is stock Mintlify boilerplate);
// the endpoints below were confirmed live against the account:
//
//   GET /api/customer/packages
//        → [{ id, product, username, created_at, ... }]     (one per plan)
//   GET /api/customer/packages/{id}
//        → { packageId, product, usedBandwidth, remainingBandwidth, ... }
//          usedBandwidth / remainingBandwidth are in **GB** (floats).
//
// We list the packages, fetch each one's usage, and sum remaining GB across
// active packages into a single pool figure — mirroring the old "sum every
// active plan" behaviour. We report remaining only (used/limit left null) so
// the poller keeps pairing it with the admin-configured plan size exactly as
// before; only the *source* of `remaining` changed.

const ENIGMA_API_BASE = 'https://enigmaproxy.net'

type EnigmaPackage = { id?: string; product?: string; inactive?: unknown }
type EnigmaPackageUsage = {
  packageId?: string
  product?: string
  usedBandwidth?: number
  remainingBandwidth?: number
  inactive?: unknown
}

async function enigmaApiGet<T>(path: string, key: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${ENIGMA_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      // Don't let a hung Enigma call stall the whole cron tick.
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(`Enigma API unreachable (${path}): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Enigma API rejected the key (${res.status}) on ${path} — ENIGMA_API_KEY is missing scope, ` +
        'revoked or wrong. Re-mint it under Dashboard → Customer API.',
    )
  }
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Enigma API ${path} returned ${res.status}: ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    // A JSON endpoint that hands back HTML means the route resolved to the
    // SPA shell (wrong path / auth silently dropped), not real data.
    throw new Error(`Enigma API ${path} returned non-JSON (got ${text.slice(0, 80)}…).`)
  }
}

/**
 * Read remaining proxy bandwidth from the Enigma Customer API. Throws (so
 * the poller reports it and skips writing a bogus snapshot) when the key is
 * missing/invalid or the API shape changed.
 */
export async function fetchEnigmaBandwidth(): Promise<ProxyTraffic> {
  const key = process.env.ENIGMA_API_KEY
  if (!key) {
    throw new Error(
      'ENIGMA_API_KEY is not set — mint an epk_ key under the Enigma dashboard (Customer API) and add it to the env.',
    )
  }

  const packages = await enigmaApiGet<EnigmaPackage[]>('/api/customer/packages', key)
  if (!Array.isArray(packages)) {
    throw new Error('Enigma API /api/customer/packages did not return a list.')
  }

  const active = packages.filter(p => p && typeof p.id === 'string' && !p.inactive)
  if (active.length === 0) {
    throw new Error('Enigma API returned no active packages — nothing to measure.')
  }

  const usages = await Promise.all(
    active.map(p => enigmaApiGet<EnigmaPackageUsage>(`/api/customer/packages/${p.id}`, key)),
  )

  let remainingGb = 0
  let usedGb = 0
  let matched = false
  const perPackage: Array<{ id: string; remainingGb: number; usedGb: number }> = []
  for (const u of usages) {
    const rem = u?.remainingBandwidth
    const used = u?.usedBandwidth
    if (typeof rem !== 'number' || !Number.isFinite(rem)) continue
    matched = true
    remainingGb += rem
    if (typeof used === 'number' && Number.isFinite(used)) usedGb += used
    perPackage.push({ id: u?.packageId ?? '', remainingGb: rem, usedGb: typeof used === 'number' ? used : 0 })
  }
  if (!matched) {
    throw new Error(
      'Enigma API returned packages but no numeric remainingBandwidth — the API shape may have changed.',
    )
  }

  return {
    // The API reports lifetime-cumulative usage, not usage against the
    // current top-up bucket, so we leave used/limit null and let the poller
    // pair remaining with the admin-configured plan size (unchanged card
    // semantics). remainingBandwidth is the number that actually matters.
    usedBytes: null,
    limitBytes: null,
    remainingBytes: Math.round(remainingGb * BYTES_PER_GB),
    raw: { source: 'enigma-api', remainingGb, usedGb, packages: perPackage },
  }
}

/** Format a byte count as a compact GB string, e.g. "3.8 GB". */
export function formatGb(bytes: number): string {
  const gb = bytes / BYTES_PER_GB
  // Show one decimal under 100 GB, whole numbers above (looks cleaner).
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
}
