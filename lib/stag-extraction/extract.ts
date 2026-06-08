/**
 * S-tag extractor. For an affiliate site:
 *   1. Pull all outbound tracking-style links from the HTML
 *   2. Follow each link's redirect chain to its final destination
 *   3. Parse the final URL's query params for an S-tag (and friends)
 *
 * Verbatim from the legacy n8n pipeline (catalog 2.8):
 *   - tracking-link path patterns: /(track|click|go|visit|out|redirect|creat|aff|ref|link|offer|bonus|promo)/
 *   - tracking-link query patterns: [?&](ref|aff|affiliate|campaign|source|tracking|click)=
 *   - business-critical query-param key order for tag extraction:
 *       ['btag', 'stag', 'cxd', 'mid', 'affid']
 */

import { resolveFinalUrlSafe } from '@/lib/affiliate-detection/fetch'

const HREF_RE = /href=["']([^"']+)["']/gi
const TRACKING_PATH_RE = /\/(track|click|go|visit|out|redirect|creat|aff|ref|link|offer|bonus|promo)\//i
const TRACKING_QUERY_RE = /[?&](ref|aff|affiliate|campaign|source|tracking|click)=/i

const STAG_PARAM_ORDER = ['btag', 'stag', 'cxd', 'mid', 'affid'] as const

const EXCLUDED_DOMAINS = new Set([
  'youtube.com',
  'youtu.be',
  'kick.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'linkedin.com',
  'pinterest.com',
  'wikipedia.org',
])

/** True if `host` is one of the excluded domains OR a subdomain of one.
 *  Exact-set membership alone misses `m.youtube.com`, `fr.wikipedia.org`,
 *  `l.facebook.com`, `lm.facebook.com` etc., which are the same property
 *  the exclude-list is meant to skip. */
function isExcludedHost(host: string): boolean {
  for (const ex of EXCLUDED_DOMAINS) {
    if (host === ex || host.endsWith('.' + ex)) return true
  }
  return false
}

export type ExtractedStag = {
  s_tag: string
  source_param: string
  brand: string | null
  tracking_url: string
  final_url: string
}

export function findTrackingLinks(html: string, baseUrl: string): string[] {
  if (!html || html.length < 100) return []

  let baseHost = ''
  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    /* keep '' */
  }

  const out = new Set<string>()
  for (const m of html.matchAll(HREF_RE)) {
    const link = m[1]
    if (!link) continue
    if (
      link.startsWith('#') ||
      link.startsWith('javascript:') ||
      link.startsWith('mailto:') ||
      link.startsWith('tel:')
    ) {
      continue
    }
    if (!TRACKING_PATH_RE.test(link) && !TRACKING_QUERY_RE.test(link)) continue

    let abs: string
    try {
      abs = new URL(link, baseUrl).toString()
    } catch {
      continue
    }
    let host: string
    try {
      host = new URL(abs).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      continue
    }
    if (isExcludedHost(host)) continue
    // Skip same-host links (we want OUTBOUND tracking)
    if (host === baseHost) continue
    out.add(abs)
    // Sanity cap per page. Bumped from 30 → 50 because aggregator
    // pages with heavy nav/footer tracking links often consumed the
    // budget on repetitive nav before reaching the mid-page review
    // CTAs (which are what we actually want for s-tag extraction).
    // Each link costs ~1–2s of Playwright redirect-resolution time
    // downstream, so this stays bounded.
    if (out.size >= 50) break
  }
  return Array.from(out)
}

export function parseStagFromUrl(rawUrl: string): { tag: string; param: string } | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  for (const key of STAG_PARAM_ORDER) {
    // Trim before the emptiness check: a `?btag=%20%20%20` yields a
    // whitespace-only value that would otherwise propagate to the s_tag
    // column, the Monday push body, and the dedupe Set as a blank tag.
    const t = u.searchParams.get(key)?.trim()
    if (t) return { tag: t, param: key }
  }
  return null
}

// Common "second-level TLDs" — when a 2-char country TLD follows one
// of these, the actual brand lives one level deeper (e.g. `casino.co.uk`
// → `casino`, not `casino.co`). Lower-case, no trailing dot.
const SECOND_LEVEL_TLDS = new Set([
  'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'mil',
])

export function guessBrandFromUrl(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
    const parts = host.split('.')
    if (parts.length < 2) return null
    // Treat e.g. `co.uk`, `com.au`, `org.uk` as a single TLD when a
    // 2-letter country code follows a known generic.
    const last = parts[parts.length - 1] ?? ''
    const penult = parts[parts.length - 2] ?? ''
    const tldDepth =
      parts.length >= 3 && last.length === 2 && SECOND_LEVEL_TLDS.has(penult) ? 2 : 1
    const brandParts = parts.slice(0, parts.length - tldDepth)
    if (brandParts.length === 0) return null
    // Return just the registrable label (eTLD+1): foo.bar.casino.co.uk →
    // "casino". A dotted brand survives display but breaks whitespace-
    // splitting downstream parsers and brandsByDomain rooster matching.
    return brandParts[brandParts.length - 1] ?? null
  } catch {
    return null
  }
}

const REDIRECT_TIMEOUT_MS = 8_000

/** Follow a single tracking link's redirect chain and return the final URL.
 *  Redirects are followed manually with a per-hop SSRF guard — these tracking
 *  URLs come from scraped third-party pages and could 30x toward an internal/
 *  metadata address. */
export async function resolveFinalUrl(trackingUrl: string): Promise<string | null> {
  return resolveFinalUrlSafe(trackingUrl, REDIRECT_TIMEOUT_MS)
}

// Plain-text URL run — stops at whitespace and common trailing delimiters.
// Used for sources that aren't HTML (e.g. a YouTube video description),
// where links are bare URLs rather than href= anchors.
const PLAIN_URL_RE = /https?:\/\/[^\s)>\]"'}]+/gi

/** Pull recognized tracking links out of plain text. Mirrors
 *  findTrackingLinks's filter (tracking path/query patterns + excluded-host
 *  skip + per-call cap) but reads bare URLs instead of href attributes. */
export function findTrackingLinksInText(text: string, maxLinks = 50): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(PLAIN_URL_RE)) {
    const link = m[0].replace(/[).,;!?'"]+$/, '') // trim prose punctuation
    if (!TRACKING_PATH_RE.test(link) && !TRACKING_QUERY_RE.test(link)) continue
    let host: string
    try {
      host = new URL(link).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      continue
    }
    if (isExcludedHost(host)) continue
    out.add(link)
    if (out.size >= maxLinks) break
  }
  return Array.from(out)
}

/** Follow each tracking link's redirect chain (parallel, concurrency-capped),
 *  parse the final URL for an s-tag, and dedupe by tag. Shared by the HTML
 *  and plain-text entry points. */
async function resolveLinksToStags(
  links: string[],
  concurrency: number,
): Promise<ExtractedStag[]> {
  if (links.length === 0) return []
  const results: (ExtractedStag | null)[] = new Array(links.length).fill(null)

  let cursor = 0
  async function consume() {
    while (true) {
      const i = cursor++
      if (i >= links.length) return
      const trackingUrl = links[i] as string
      const finalUrl = await resolveFinalUrl(trackingUrl)
      if (!finalUrl) continue
      const parsed = parseStagFromUrl(finalUrl)
      if (!parsed) continue
      results[i] = {
        s_tag: parsed.tag,
        source_param: parsed.param,
        brand: guessBrandFromUrl(finalUrl),
        tracking_url: trackingUrl,
        final_url: finalUrl,
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, () => consume()))

  // Dedupe by s_tag
  const seen = new Set<string>()
  const out: ExtractedStag[] = []
  for (const r of results) {
    if (!r) continue
    if (seen.has(r.s_tag)) continue
    seen.add(r.s_tag)
    out.push(r)
  }
  return out
}

/**
 * Given an affiliate page's HTML + base URL, extract every s-tag we
 * can resolve. Resolves redirects in parallel with a concurrency cap.
 */
export async function extractStagsFromHtml(
  html: string,
  baseUrl: string,
  opts: { concurrency?: number; maxLinks?: number } = {},
): Promise<ExtractedStag[]> {
  const links = findTrackingLinks(html, baseUrl).slice(0, opts.maxLinks ?? 30)
  return resolveLinksToStags(links, opts.concurrency ?? 5)
}

/**
 * Like extractStagsFromHtml but for plain text — e.g. a YouTube video
 * description, where affiliate links appear as bare URLs. Same resolve +
 * s-tag-parse + dedupe pipeline.
 */
export async function extractStagsFromText(
  text: string,
  opts: { concurrency?: number; maxLinks?: number } = {},
): Promise<ExtractedStag[]> {
  const links = findTrackingLinksInText(text, opts.maxLinks ?? 30)
  return resolveLinksToStags(links, opts.concurrency ?? 5)
}
