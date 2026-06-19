import 'server-only'

/**
 * Proxy bandwidth helpers — read remaining proxy data from the metered
 * plan that actually carries our scrapes.
 *
 * ACTIVE SOURCE: Enigma (resi.enigmaproxy.net). The GoLogin profiles
 * route through Enigma residential proxies on a metered plan that Chris
 * tops up (the "15 GB"). Enigma has no usable API (its public API is
 * reseller-gated) and its login is Cloudflare-Turnstile-protected, so we
 * read the balance by fetching the logged-in dashboard with a copied
 * `__session` cookie (ENIGMA_COOKIE) and scraping the remaining-GB value.
 * See fetchEnigmaBandwidth below. The cookie is a "session" cookie and
 * will eventually expire — when it does the poll fails and the dashboard
 * card goes stale until a fresh cookie is pasted into the env.
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
// Enigma (active source) — scrape remaining GB from the logged-in dashboard.
// ---------------------------------------------------------------------------

const ENIGMA_DASHBOARD_URL = 'https://enigmaproxy.net/dashboard'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * Pull the remaining-GB total out of the Enigma dashboard HTML.
 *
 * The dashboard renders an "Active plans" panel containing one card per
 * active plan (Residential, Mobile, etc.), each showing its remaining
 * data as e.g. `11.67 GB`. We anchor on the panel heading text and sum
 * every "N GB" inside that scope so multiple active plans collapse into
 * one pool figure.
 *
 * History: the original parser required a literal `<!-- -->` between
 * the number and "GB" (React text-node separator). When that markup
 * shape changed the parser silently started matching unrelated "0 GB"
 * elements elsewhere on the page (a depleted-plan card or a "0 days"
 * counter), writing remaining=0 snapshots forever. Scoping to the
 * "Active plans" panel + dropping the comment requirement avoids both
 * failure modes.
 *
 * Returns null when the heading anchor can't be found (layout change or
 * a logged-out shell) so the poller skips writing a bogus snapshot.
 */
const ENIGMA_ACTIVE_PLANS_RE = /Active\s+plans?/i
// Number, optional whitespace + arbitrary HTML tags/comments, then "GB"
// as a word. Accepts every Enigma markup variant seen so far:
//   `11.67<!-- --> GB`   (old React separator)
//   `11.67 GB`           (current)
//   `11.67<span>GB</span>` (hypothetical future)
const GB_VALUE_RE = /(\d+(?:\.\d+)?)\s*(?:<!--[\s\S]*?-->|<[^>]*>|\s)*GB\b/gi
// Slice cap: an "Active plans" panel with a handful of cards is well
// under 8 KB of HTML. Larger windows risk leaking into the next panel
// (Billing / Buy more / etc.) where unrelated GB values appear.
const ENIGMA_PANEL_WINDOW = 8_000

export function parseEnigmaRemainingGb(html: string): number | null {
  const anchor = html.search(ENIGMA_ACTIVE_PLANS_RE)
  if (anchor === -1) return null
  const panel = html.slice(anchor, anchor + ENIGMA_PANEL_WINDOW)
  const matches = [...panel.matchAll(GB_VALUE_RE)]
    .map(m => parseFloat(m[1] ?? ''))
    .filter(n => Number.isFinite(n))
  if (matches.length === 0) return null
  return matches.reduce((a, b) => a + b, 0)
}

/**
 * Fetch the Enigma dashboard with the copied session cookie and return
 * remaining bandwidth. Throws (so the poller reports it and skips writing
 * a bogus snapshot) when the cookie is missing/expired or the page shape
 * changed.
 */
export async function fetchEnigmaBandwidth(): Promise<ProxyTraffic> {
  const cookie = process.env.ENIGMA_COOKIE
  if (!cookie) {
    throw new Error(
      'ENIGMA_COOKIE is not set — copy the __session cookie from the Enigma dashboard into the env.',
    )
  }

  let res: Response
  try {
    res = await fetch(ENIGMA_DASHBOARD_URL, {
      headers: {
        Cookie: `__session=${cookie}`,
        'User-Agent': BROWSER_UA,
        Accept: 'text/html',
      },
      redirect: 'manual', // a redirect to /login means the session died
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(`Enigma dashboard unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (res.status >= 300 && res.status < 400) {
    throw new Error('Enigma session expired (redirected to login) — paste a fresh ENIGMA_COOKIE.')
  }
  if (!res.ok) {
    throw new Error(`Enigma dashboard returned ${res.status} (Cloudflare block or session issue).`)
  }

  const html = await res.text()
  const remainingGb = parseEnigmaRemainingGb(html)
  if (remainingGb === null) {
    throw new Error(
      'Could not find a remaining-GB value on the Enigma dashboard — the session may be invalid or the page layout changed.',
    )
  }

  return {
    usedBytes: null,
    limitBytes: null, // Enigma's dashboard shows remaining only, not the original plan size
    remainingBytes: Math.round(remainingGb * BYTES_PER_GB),
    raw: { source: 'enigma', remainingGb },
  }
}

/** Format a byte count as a compact GB string, e.g. "3.8 GB". */
export function formatGb(bytes: number): string {
  const gb = bytes / BYTES_PER_GB
  // Show one decimal under 100 GB, whole numbers above (looks cleaner).
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
}
