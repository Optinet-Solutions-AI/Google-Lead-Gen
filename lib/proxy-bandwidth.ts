import 'server-only'

/**
 * Proxy bandwidth helpers — fetch + parse GoLogin's proxy traffic usage.
 *
 * Our scrapers run through GoLogin-managed residential proxies on a
 * metered plan. GoLogin exposes a traffic-usage endpoint we can poll
 * with the same GOLOGIN_API_TOKEN the workers use, so we read the real
 * consumption from the source of truth rather than estimating bytes
 * ourselves (which would drift from the plan's meter).
 *
 * The documented response schema is incomplete, so parseGoLoginTraffic
 * is deliberately tolerant: it hunts for the usual field names and
 * keeps the raw blob for debugging. Run
 * `npx tsx scripts/qa/peek-gologin-traffic.ts` against the real account
 * to confirm the exact shape, then tighten this if needed.
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

export type GoLoginTraffic = {
  /** Bytes consumed, or null if the response didn't expose it. */
  usedBytes: number | null
  /** Plan allowance in bytes if GoLogin reports it, else null. */
  limitBytes: number | null
  /** Bytes remaining if GoLogin reports it directly, else null. */
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
export function parseGoLoginTraffic(raw: unknown): Omit<GoLoginTraffic, 'raw'> {
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
export async function fetchGoLoginTraffic(): Promise<GoLoginTraffic> {
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

/** Format a byte count as a compact GB string, e.g. "3.8 GB". */
export function formatGb(bytes: number): string {
  const gb = bytes / BYTES_PER_GB
  // Show one decimal under 100 GB, whole numbers above (looks cleaner).
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
}
