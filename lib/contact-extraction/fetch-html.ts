import 'server-only'

/**
 * Bounded, best-effort page fetcher for server-side contact extraction.
 *
 * Used by the Facebook Phase-3 scorer to pull an affiliate's own link-hub
 * (heylink.me / linktr.ee / …) or landing page so the HTML contact extractor
 * can mine the email / Telegram / Discord they publish there. The FB scrape
 * itself never fetches these pages — it only captures the ad cards — so this is
 * the one place contacts get harvested.
 *
 * Deliberately conservative: a browser-ish UA, a short timeout, a body cap, an
 * html-only content-type gate, and an SSRF guard against internal hosts. Never
 * throws — a failed fetch just yields no html for that url, mirroring
 * resolve-links.ts's "a failed resolve leaves resolved_url null" contract.
 */

// A plausible desktop UA — some hubs serve a stripped page (or 403) to an
// obvious bot UA, hiding the very contact links we're after.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// Cap the body we parse — hub/contact pages are small; this guards against a
// stray multi-MB document blowing up the regex passes.
const MAX_BODY_CHARS = 2_000_000

/** Block obviously-internal targets so a scraped URL can't point the fetch at
 *  loopback / link-local / private space (basic SSRF hygiene). */
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '0.0.0.0' || h === '127.0.0.1' || h.startsWith('127.')) return true
  if (h === '::1' || h === '[::1]') return true
  if (h.startsWith('10.') || h.startsWith('192.168.')) return true
  if (h.startsWith('169.254.')) return true // link-local / cloud metadata
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true // 172.16/12
  return false
}

/** True only for an http(s) URL safe to fetch server-side. */
function isFetchable(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return !isInternalHost(u.hostname)
  } catch {
    return false
  }
}

/**
 * Fetch one page's HTML. Returns the (size-capped) body string, or null on any
 * failure / non-html response / timeout. Never throws.
 */
export async function fetchPageHtml(url: string, timeoutMs = 8000): Promise<string | null> {
  if (!isFetchable(url)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    })
    if (!res.ok) return null
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
    // Empty content-type is common on bare hubs — allow it; reject only clearly
    // non-html payloads (images, pdfs, json APIs).
    if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) return null
    const body = await res.text()
    return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch a batch of pages with bounded concurrency and a hard cap on total
 * fetches, so the calling server action stays well under the function timeout.
 * Returns a Map of url → html for those that fetched successfully.
 */
export async function fetchPagesHtml(
  urls: string[],
  { concurrency = 6, cap = 80, timeoutMs = 8000 }: { concurrency?: number; cap?: number; timeoutMs?: number } = {},
): Promise<Map<string, string>> {
  const targets = [...new Set(urls.filter(isFetchable))].slice(0, cap)
  const out = new Map<string, string>()
  let i = 0
  async function worker() {
    while (i < targets.length) {
      const url = targets[i++]
      if (url === undefined) continue
      const html = await fetchPageHtml(url, timeoutMs)
      if (html) out.set(url, html)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  return out
}
