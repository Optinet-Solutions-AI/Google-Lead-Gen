import 'server-only'

import { resolveFinalUrlSafe } from './fetch'

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
  // Heavily used by gambling-affiliate ads (esp. AU Facebook Ad Library):
  // tny.sh carries affiliate campaign codes in the path (e.g.
  // tny.sh/AU390425001-FT) and 30x-redirects to the operator with the stag.
  'tny.sh', 't.ly', 's.id', 'v.gd', 'soo.gd', 'clck.ru',
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
 *
 * Redirects are followed manually with a per-hop SSRF guard (see
 * resolveFinalUrlSafe): the input host is shortener-allowlisted, but a
 * shortener can 30x toward an internal/metadata address, so each hop is
 * re-validated before we connect.
 */
export async function resolveShortener(url: string, timeoutMs = 4000): Promise<string | null> {
  const final = await resolveFinalUrlSafe(url, timeoutMs)
  return final && final !== url ? final : null
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
