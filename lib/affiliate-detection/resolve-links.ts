import 'server-only'

/**
 * Server-side shortener resolution for kick_links (Phase 3).
 *
 * Scoped narrowly to true URL shorteners that answer with a 30x redirect
 * (bit.ly, t.co, cutt.ly, …) — following those reveals the real casino
 * destination. We deliberately do NOT fetch direct casino brand links
 * (rainbet.com, stake.com): those are Cloudflare-gated and would block a
 * server-side fetch, and their brand is already captured in promo_brand.
 * Link-aggregator PAGES (linktr.ee, beacons.ai) are 200s, not redirects, so
 * they can't be expanded this way either — out of scope (see plan).
 */

const SHORTENER_HOSTS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'cutt.ly', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'shorturl.at', 'rb.gy', 'is.gd', 'snip.ly', 'lnk.to',
  'tiny.cc', 'shrtco.de', 'short.gy', 'trib.al',
])

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** True only for links worth a server-side redirect-follow. */
export function needsResolution(url: string): boolean {
  return SHORTENER_HOSTS.has(hostOf(url))
}

/**
 * Follow redirects to the final URL. Returns the resolved URL when it
 * differs from the input, else null (no-op / unresolved / blocked). Never
 * throws — a failed resolve just leaves resolved_url null.
 */
export async function resolveShortener(url: string, timeoutMs = 4000): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal })
      // Some shorteners reject HEAD — retry with GET.
      if (!res.ok || res.url === url) {
        res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal })
      }
    } catch {
      return null
    }
    const final = res.url
    return final && final !== url ? final : null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a batch of URLs with bounded concurrency. Returns a Map of
 * input-url → resolved-url for those that actually resolved. Caps total
 * work so the calling server action stays well under the function timeout.
 */
export async function resolveShorteners(
  urls: string[],
  { concurrency = 8, cap = 60 }: { concurrency?: number; cap?: number } = {},
): Promise<Map<string, string>> {
  const targets = [...new Set(urls.filter(needsResolution))].slice(0, cap)
  const out = new Map<string, string>()
  let i = 0
  async function worker() {
    while (i < targets.length) {
      const url = targets[i++]
      if (url === undefined) continue
      const resolved = await resolveShortener(url)
      if (resolved) out.set(url, resolved)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  return out
}
