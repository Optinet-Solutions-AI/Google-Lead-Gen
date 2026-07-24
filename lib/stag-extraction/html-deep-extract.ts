/**
 * [LGP-101 + T3 DOM DEEP tier]
 *
 * Extract affiliate tags from HTML that our T1 URL-param check missed —
 * covers three sources modern operator sites hide the tag in:
 *
 *   1. __NEXT_DATA__ / __NUXT__ / __INITIAL_STATE__ script-tags: modern
 *      SSR frameworks bake their entire server state into a JSON script
 *      tag. Affiliate IDs are often nested a few levels deep in there
 *      (`state.tracking.affId`, `props.pageProps.partnerId`, ...). Just
 *      grep the JSON for network-shaped keys.
 *
 *   2. data-attributes: `<a data-affid="cxd_1234">`, `<div
 *      data-partner-id="12345">`, etc. Trivially scannable regex.
 *
 *   3. Inline script tag globals: `window.__AFF_ID__ = "12345"`,
 *      `dataLayer.push({ affiliateId: "..." })`, GTM patterns.
 *
 * The whole thing is regex-based intentionally — pulling in cheerio /
 * jsdom means paying ~2 MB of dependency and ~100ms of parse time on
 * every extraction. Regex is ugly but fast, and the payload volumes
 * we're mining are small (single-tag-per-lead, key/value pairs).
 *
 * Returns the FIRST matching (tag, network, source_param) tuple. The
 * outer pipeline is responsible for chaining T1 → this module → T3
 * cookie extractor, so we can just early-return here.
 */
import { AFFILIATE_NETWORKS } from './networks'

/** Where in the HTML the match came from — surfaced as `extracted_via`
 *  so the audit can attribute lift to the right sub-tier. */
export type DeepExtractSource =
  | 't1_html_next_data'
  | 't1_html_data_attr'
  | 't1_html_inline_js'

export type DeepExtractResult = {
  s_tag: string
  source_param: string
  network: string
  extracted_via: DeepExtractSource
}

/**
 * Try each of the three parsers in order (cheapest first) and return
 * the first non-null result. Returns null if none matched.
 */
export function extractFromHtml(html: string): DeepExtractResult | null {
  if (!html || html.length < 200) return null
  return (
    extractFromNextData(html) ||
    extractFromDataAttrs(html) ||
    extractFromInlineJs(html)
  )
}

/* ----------------------------------------------------------------------------
 * 1. __NEXT_DATA__ / __NUXT__ / __INITIAL_STATE__ SSR state
 * ------------------------------------------------------------------------- */

const SSR_SCRIPT_RE =
  /<script(?:\s+id=["'](__NEXT_DATA__|__NUXT_DATA__)["'])?[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi

const WINDOW_STATE_RE =
  /(?:__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__APOLLO_STATE__|window\.__DATA__|__PRELOADED_STATE__)\s*=\s*(\{[\s\S]{50,500000}?\})\s*[;<]/i

export function extractFromNextData(html: string): DeepExtractResult | null {
  // First try tagged JSON script blocks.
  for (const m of html.matchAll(SSR_SCRIPT_RE)) {
    const body = m[2]?.trim() ?? ''
    if (!body || body.length < 50) continue
    const found = grepJsonForAffiliate(body)
    if (found) return { ...found, extracted_via: 't1_html_next_data' }
  }
  // Then try inline `window.__NEXT_DATA__ = { ... };` assignments.
  const winMatch = html.match(WINDOW_STATE_RE)
  if (winMatch?.[1]) {
    const found = grepJsonForAffiliate(winMatch[1])
    if (found) return { ...found, extracted_via: 't1_html_next_data' }
  }
  return null
}

/**
 * Walk a JSON string looking for affiliate-shaped key/value pairs. Uses
 * regex over the string (not JSON.parse — SSR states can be
 * multi-megabyte and we don't need the parsed tree). We DO check every
 * key from every network in the catalog.
 */
function grepJsonForAffiliate(jsonText: string): {
  s_tag: string
  source_param: string
  network: string
} | null {
  for (const network of AFFILIATE_NETWORKS) {
    for (const paramName of network.urlParams) {
      // Match e.g. "cxd":"abc123" or "cxd":"abc-123_x"
      const re = new RegExp(
        `["']${escapeReChar(paramName)}["']\\s*:\\s*["']([^"']{3,128})["']`,
        'i',
      )
      const m = jsonText.match(re)
      if (!m || !m[1]) continue
      const v = m[1].trim()
      if (!v) continue
      if (network.valueShape && !network.valueShape.test(v)) continue
      return { s_tag: v, source_param: paramName, network: network.key }
    }
  }
  return null
}

/* ----------------------------------------------------------------------------
 * 2. data-* attributes on rendered elements
 * ------------------------------------------------------------------------- */

const DATA_ATTR_RE =
  /data-(?:aff(?:iliate)?[-_]?id|affid|partner[-_]?id|partnerid|btag|stag|cxd|clickid|irclickid|a_aid|ef_click|sub_aff|source[-_]?id)\s*=\s*["']([^"']{3,128})["']/gi

export function extractFromDataAttrs(html: string): DeepExtractResult | null {
  for (const m of html.matchAll(DATA_ATTR_RE)) {
    const value = m[1]?.trim() ?? ''
    if (!value) continue
    // Extract the actual attribute name that matched for source_param.
    const attrMatch = m[0].match(/data-([\w-]+)/i)
    const attrName = attrMatch?.[1]?.toLowerCase() ?? 'data-aff'
    // Route through networks catalog for network attribution.
    const matched = matchToNetwork(attrName, value)
    return {
      s_tag: value,
      source_param: attrName,
      network: matched?.key ?? 'unknown',
      extracted_via: 't1_html_data_attr',
    }
  }
  return null
}

/* ----------------------------------------------------------------------------
 * 3. Inline JS globals + dataLayer pushes
 * ------------------------------------------------------------------------- */

const INLINE_GLOBAL_PATTERNS: RegExp[] = [
  /window\.__AFF(?:_ID|ILIATE)?[_A-Z]*\s*=\s*["']([^"']{3,128})["']/i,
  /(?:var|let|const)\s+(?:aff(?:iliate)?|partner)[_A-Z]?[iI]d\s*=\s*["']([^"']{3,128})["']/i,
  /dataLayer\.push\(\{[^}]*(?:aff(?:iliate)?[_A-Za-z]*[Ii]d|partner[_A-Za-z]*[Ii]d)\s*:\s*["']([^"']{3,128})["']/i,
  /gtag\(['"](?:config|event)['"],\s*['"](?:AW|G)-[^'"]+['"]\s*,\s*\{[^}]*['"](?:aff(?:iliate)?[_A-Za-z]*[Ii]d)['"]\s*:\s*["']([^"']{3,128})["']/i,
]

export function extractFromInlineJs(html: string): DeepExtractResult | null {
  for (const rx of INLINE_GLOBAL_PATTERNS) {
    const m = html.match(rx)
    if (!m) continue
    const v = (m[1] ?? m[2])?.trim() ?? ''
    if (!v) continue
    return {
      s_tag: v,
      source_param: 'inline_js',
      network: 'unknown',
      extracted_via: 't1_html_inline_js',
    }
  }
  return null
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function escapeReChar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchToNetwork(attrOrKey: string, value: string): { key: string } | null {
  const lower = attrOrKey.toLowerCase().replace(/^data-/, '').replace(/[-_]/g, '')
  for (const network of AFFILIATE_NETWORKS) {
    for (const p of network.urlParams) {
      if (p.toLowerCase().replace(/[-_]/g, '') === lower) {
        if (network.valueShape && !network.valueShape.test(value)) continue
        return { key: network.key }
      }
    }
    for (const c of network.cookieNames) {
      if (c.toLowerCase().replace(/[-_]/g, '') === lower) return { key: network.key }
    }
  }
  return null
}
