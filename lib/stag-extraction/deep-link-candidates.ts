/**
 * [LGP-092] Deep-link exploration.
 *
 * Casino review sites often have STALE tracking on their homepage but
 * FRESH tracking on their conversion pages (/join, /promo, /welcome-
 * offer, etc.). This module finds the deep-link candidates on a page
 * — the extractor pipeline (v2, T3) hands them to the tier-1 URL
 * extractor recursively.
 *
 * The heuristic:
 *   1. Find <a href> tags whose path matches a conversion-page pattern
 *      (join, sign-up, promo, bonus, welcome-offer, get-started, ...)
 *   2. Prefer links whose visible link-text ALSO signals conversion
 *      ("Sign up", "Get bonus", "Play now", "Join", "Claim now"...)
 *   3. Skip nav-links (in <nav>/<header>) unless they're the only
 *      candidates.
 *   4. Cap at 5 candidates per page — we don't want to blow the T3
 *      budget on a single lead with 40 nav links.
 *
 * The regex library is CASE-INSENSITIVE and INTENTIONALLY generous.
 * We'd rather false-positive on a candidate that returns nothing than
 * miss a real conversion page.
 */

/** Path fragments that signal a conversion / bonus / join page. */
const CONVERSION_PATH_PATTERNS: RegExp[] = [
  /\/(join|register|sign[-_]?up|sign[-_]?in|welcome)/i,
  /\/(promo|promos|promotion|promotions|bonus|bonuses)/i,
  /\/(welcome[-_]?offer|welcome[-_]?bonus|get[-_]?started|get[-_]?bonus)/i,
  /\/(play|play[-_]?now|claim|claim[-_]?bonus)/i,
  /\/(offer|offers|special|specials|new[-_]?player)/i,
  /\/(deposit|first[-_]?deposit)/i,
  /\/(refer[-_]?a[-_]?friend|referral)/i,
]

/** Visible link-text that reinforces the path-based signal. */
const CONVERSION_TEXT_PATTERNS: RegExp[] = [
  /\b(sign\s?up|join\s?now|register)\b/i,
  /\b(get\s?bonus|claim\s?bonus|get\s?started)\b/i,
  /\b(play\s?now|play\s?free)\b/i,
  /\b(welcome\s?offer|welcome\s?bonus)\b/i,
  /\b(deposit\s?now|make\s?a\s?deposit)\b/i,
]

/** Path fragments that DEFINITELY aren't conversion pages — dropped
 *  from candidates even if they superficially match above. */
const EXCLUDE_PATTERNS: RegExp[] = [
  /\/(login|log[-_]?in|logout|forgot)/i,
  /\/(privacy|terms|tos|about|contact|imprint|impressum)/i,
  /\/(help|faq|support)/i,
  /\/(blog|news|article|articles)/i,
  /\/(app|mobile|download)/i,
  /\/(responsible[-_]?gambling|self[-_]?exclusion)/i,
]

export type DeepLinkCandidate = {
  /** Absolute URL. */
  url: string
  /** Score 0..3, higher = more confidence it's a conversion page. */
  confidence: number
  /** Which signal(s) matched. Debug aid. */
  reason: string[]
}

/**
 * Find deep-link candidates on `html` at `baseUrl`. Case-insensitive.
 * Duplicates dropped. Returns up to `cap` (default 5) candidates
 * sorted by confidence desc.
 */
export function findDeepLinkCandidates(
  html: string,
  baseUrl: string,
  cap = 5,
): DeepLinkCandidate[] {
  if (!html || html.length < 100) return []

  let baseHost = ''
  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return []
  }

  const seen = new Map<string, DeepLinkCandidate>()

  // <a href="..." ...>TEXT</a> — non-greedy so we don't slurp two
  // links at once when they're right next to each other. Also
  // captures the anchor's text (best-effort — a nested <img alt="…">
  // would evade this, but that's fine for our heuristic).
  const anchorRe = /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(anchorRe)) {
    const attrsBefore = m[1] ?? ''
    const href = m[2] ?? ''
    const attrsAfter = m[3] ?? ''
    const inner = m[4] ?? ''
    if (!href) continue

    // Cheap early skips.
    if (
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      continue
    }

    let absUrl: URL
    try {
      absUrl = new URL(href, baseUrl)
    } catch {
      continue
    }

    // Same-domain only — deep-link exploration is about finding a
    // fresher affiliate ID on the CURRENT operator's own conversion
    // pages, not about following outbound tracking (that's T1's
    // job).
    const host = absUrl.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== baseHost) continue

    // If the anchor is inside a <nav> or <header>, drop confidence
    // by 1 — nav links tend to be homepage links, not fresh
    // conversion CTAs. Detected by looking for `class="…nav…"` /
    // `role="navigation"` on the anchor's attrs.
    const attrs = attrsBefore + ' ' + attrsAfter
    const isNav = /class=["'][^"']*(nav|header|menu|breadcrumb)/i.test(attrs)

    const pathPlusQuery = absUrl.pathname + absUrl.search
    if (EXCLUDE_PATTERNS.some(rx => rx.test(pathPlusQuery))) continue

    let confidence = 0
    const reasons: string[] = []

    if (CONVERSION_PATH_PATTERNS.some(rx => rx.test(pathPlusQuery))) {
      confidence += 2
      reasons.push('path')
    }
    const visibleText = stripHtml(inner).slice(0, 200)
    if (CONVERSION_TEXT_PATTERNS.some(rx => rx.test(visibleText))) {
      confidence += 1
      reasons.push('text')
    }
    if (isNav && confidence > 0) {
      confidence -= 1
      reasons.push('nav-penalty')
    }
    if (confidence <= 0) continue

    const canonical = absUrl.href.split('#')[0] ?? absUrl.href
    const existing = seen.get(canonical)
    if (existing) {
      // Keep the higher-confidence + combine reasons.
      if (confidence > existing.confidence) {
        seen.set(canonical, {
          url: canonical,
          confidence,
          reason: Array.from(new Set([...existing.reason, ...reasons])),
        })
      }
    } else {
      seen.set(canonical, { url: canonical, confidence, reason: reasons })
    }
  }

  const sorted = Array.from(seen.values()).sort((a, b) => b.confidence - a.confidence)
  return sorted.slice(0, cap)
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
