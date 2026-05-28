/**
 * Decode a Google or Bing ad click-tracker URL into the real
 * destination. PPC leads whose scrape-time click-through failed are
 * stored with the raw redirect URL (e.g. `https://www.bing.com/aclk?
 * ld=...&u=<base64>...`), and the enrichment worker just `driver.get`s
 * that — landing on a Bing/Google error or search-results page instead
 * of the actual advertiser. This helper extracts the destination URL
 * statically from the querystring so the worker visits the right page.
 *
 * Returns the input unchanged if the URL is not a recognized click
 * tracker or the embedded destination can't be decoded.
 */

export function decodeAdUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname

  // Google: /aclk and /pagead/aclk carry the destination in `adurl=`,
  // URL-encoded (no base64 layer).
  if (
    (host === 'www.google.com' || host === 'google.com' || host.endsWith('.google.com')) &&
    (path === '/aclk' || path === '/pagead/aclk' || path.endsWith('/aclk'))
  ) {
    const adurl = url.searchParams.get('adurl') || url.searchParams.get('q')
    if (adurl && adurl.startsWith('http')) return adurl
  }
  if (host === 'googleadservices.com' || host.endsWith('.googleadservices.com')) {
    const adurl = url.searchParams.get('adurl')
    if (adurl && adurl.startsWith('http')) return adurl
  }

  // Bing: three variants share the same `u=` payload (base64 of a
  // URL-encoded URL). The legacy /ck/a payload has a 2-char prefix
  // (`a1`) before the base64; /aclk and /aclick do not.
  if (host === 'www.bing.com' || host === 'bing.com' || host.endsWith('.bing.com')) {
    const u = url.searchParams.get('u')
    if (u) {
      const isLegacyCk = path.startsWith('/ck/a')
      const candidates = isLegacyCk
        ? [u.slice(2), u] // legacy first, fall back to whole (some /ck/a have no prefix)
        : [u, u.slice(2)] // newer aclk/aclick first, fall back if it looks prefixed
      for (const c of candidates) {
        const decoded = tryDecodeBingPayload(c)
        if (decoded) return decoded
      }
    }
  }

  return rawUrl
}

function tryDecodeBingPayload(payload: string): string | null {
  if (payload.length < 4) return null
  // URL-safe base64 → standard base64, then pad to multiple of 4.
  let body = payload.replace(/-/g, '+').replace(/_/g, '/')
  body += '='.repeat((-body.length) & 3)
  let decoded: string
  try {
    decoded = Buffer.from(body, 'base64').toString('utf8')
  } catch {
    return null
  }
  // Bing wraps the destination in percent-encoding inside the base64.
  let unescaped: string
  try {
    unescaped = decodeURIComponent(decoded)
  } catch {
    return null
  }
  if (unescaped.startsWith('//')) return 'https:' + unescaped
  if (unescaped.startsWith('http')) return unescaped
  return null
}
