/**
 * Plain HTTP fetcher with browser-ish headers + timeout.
 *
 * For first iteration. Many casino-affiliate sites are behind
 * Cloudflare and will return 403/503 to us — those rows simply
 * get classified with confidence ERROR and the user can retry
 * or override manually. A future iteration can swap this for a
 * VM-side fetch through a residential proxy.
 */

const DEFAULT_TIMEOUT_MS = 8_000

const BROWSER_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
}

export type FetchResult =
  | { ok: true; html: string; finalUrl: string; status: number }
  | { ok: false; error: string; status: number | null }

const MAX_REDIRECTS = 5

// --- SSRF guard -----------------------------------------------------------
// The URL here comes from a lead row (search-result domain), so a malicious
// page can 302 us toward cloud metadata (169.254.169.254), localhost, or
// an internal RFC1918 host. We follow redirects manually and re-validate
// each hop's target BEFORE connecting.

function ipv4IsBlocked(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some(n => n > 255)) return true // malformed octet → block
  const [a, b, c] = o as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true        // this-net / private / loopback
  if (a === 169 && b === 254) return true                  // link-local (incl. 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true         // private
  if (a === 192 && b === 168) return true                  // private
  if (a === 100 && b >= 64 && b <= 127) return true        // CGNAT
  if (a === 192 && b === 0 && c === 0) return true         // 192.0.0.0/24 (IETF protocol)
  if (a >= 224) return true                                // multicast / reserved / broadcast
  return false
}

function ipv6IsBlocked(ip: string): boolean {
  let h = ip.toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  const pct = h.indexOf('%')
  if (pct >= 0) h = h.slice(0, pct) // drop zone id
  if (h === '::1' || h === '::') return true                                 // loopback / unspecified
  if (/^fe[89ab]/.test(h)) return true                                       // link-local fe80::/10
  if (/^f[cd]/.test(h)) return true                                          // ULA fc00::/7
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)     // IPv4-mapped
  if (mapped?.[1]) return ipv4IsBlocked(mapped[1])
  return false
}

function ipLiteralKind(host: string): 'v4' | 'v6' | null {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'v4'
  if (host.includes(':') || (host.startsWith('[') && host.endsWith(']'))) return 'v6'
  return null
}

/** True if the URL targets a non-public address. Literal-IP and reserved-
 *  hostname checks always run; DNS resolution is best-effort (Node-only,
 *  dynamically imported) to also catch names that resolve to internal IPs. */
async function isBlockedTarget(rawUrl: string): Promise<boolean> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return true // unparseable → block
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true
  const lit = ipLiteralKind(host)
  if (lit === 'v4') return ipv4IsBlocked(host)
  if (lit === 'v6') return ipv6IsBlocked(host)
  try {
    const dns = await import('node:dns/promises')
    const addrs = await dns.lookup(host, { all: true })
    for (const { address, family } of addrs) {
      if (family === 4 ? ipv4IsBlocked(address) : ipv6IsBlocked(address)) return true
    }
  } catch {
    // dns unavailable or lookup failed — literal checks above already cover
    // the cited attack (a 302 to an IP literal or reserved hostname).
  }
  return false
}

export async function fetchHtml(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let currentUrl = url
    for (let hop = 0; ; hop++) {
      if (await isBlockedTarget(currentUrl)) {
        return { ok: false, error: 'Blocked non-public address', status: null }
      }
      const res = await fetch(currentUrl, {
        method: 'GET',
        headers: BROWSER_HEADERS,
        redirect: 'manual', // we validate each hop before following it
        signal: controller.signal,
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return { ok: false, error: `HTTP ${res.status} with no Location`, status: res.status }
        if (hop >= MAX_REDIRECTS) return { ok: false, error: 'Too many redirects', status: res.status }
        try {
          currentUrl = new URL(loc, currentUrl).toString()
        } catch {
          return { ok: false, error: 'Bad redirect location', status: res.status }
        }
        continue
      }
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}`, status: res.status }
      }
      const ctype = res.headers.get('content-type') ?? ''
      if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
        return { ok: false, error: `Non-HTML content-type: ${ctype}`, status: res.status }
      }
      const html = await res.text()
      return { ok: true, html, finalUrl: res.url || currentUrl, status: res.status }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg, status: null }
  } finally {
    clearTimeout(timer)
  }
}
