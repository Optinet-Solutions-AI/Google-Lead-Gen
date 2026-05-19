/**
 * Regex-based contact extractor with anti-obfuscation pre-pass.
 *
 * Catches the common casino-affiliate patterns:
 *   - mailto: + tel: links from anchor tags
 *   - Plain-text emails / phones
 *   - Obfuscated emails: "support [at] example dot com",
 *     "&#64;" entity, "(at)", "{dot}" — see deobfuscate() below
 *
 * Returns null/empty arrays when it can't find anything; the
 * enrichment cascade then escalates to GPT-4o + Hunter.io.
 */

// TLD class allows letters/digits/hyphens after a leading letter, with
// a 63-char cap (RFC 1035). Without this, punycode IDN TLDs like
// `.xn--p1ai` (`.рф`) and `.xn--80akhbyknj4f` are rejected, so domains
// under those TLDs yield zero emails from the regex tier and fall
// straight to the LLM/Hunter fallback.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z][A-Z0-9-]{1,62}/gi
const MAILTO_RE = /href=["']mailto:([^"'?]+)/gi
const TEL_RE = /href=["']tel:([^"']+)/gi
// Dropped `.` from the separator class — without it, version strings
// like `v1.2.3.4567` and EU prices like `12.345.678,90` were matched
// as phones, both of which then survived the digit-count filter at the
// callsite. Dotted-phone formats like `+1.555.123.4567` (mostly US
// internal) are no longer caught; non-dotted formats (`+1 555-123-4567`,
// `(555) 123-4567`, `+44 20 7123 4567`) still match.
const PHONE_RE = /(?<!\d)(\+?\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g
// Match contact-shaped paths only when the keyword is followed by a
// real boundary character (path separator, dot, dash, query, hash, or
// end-of-href quote). Without the lookahead the bare `\b(about)` form
// matched `aboutads.info`, `aboutme.com`, `aboutus-policy`, even though
// only `/about`, `/about-us`, `/about.html`, `/about?...` are legit.
const CONTACT_LINK_RE = /href=["']([^"']*\b(contact|kontakt|about|impressum)(?=[-_/.?#]|["'])[^"']*)["']/gi

const EXCLUDED_EMAIL_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'pdf'])

const COMMON_NOISE_DOMAINS = [
  'sentry.io',
  'sentry-cdn.com',
  'wixpress.com',
  'wix.com',
  'gtm.js',
  'googletagmanager.com',
  'cookiebot.com',
]

export type ContactResult = {
  emails: string[]
  phones: string[]
  contactPageUrl: string | null
  raw: {
    emailCandidates: number
    phoneCandidates: number
    mailtoCount: number
  }
}

/**
 * Reverse common anti-bot email obfuscations.
 *
 * Targeted rules — bracketed [at]/(at)/{at} are unambiguous, so we
 * replace them anywhere. The bare-word " at "/" dot " replacement
 * is gated by an email-shaped surrounding context to avoid corrupting
 * normal sentences like "Meet us at the office".
 */
// `String.fromCodePoint` raises RangeError on lone surrogates (U+D800..U+DFFF)
// and values > U+10FFFF. A single bad numeric entity in untrusted HTML would
// abort the whole `.replace` chain and crash enrichment. Clamp to printable
// non-surrogate range.
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp)) return ' '
  if (cp < 0x20 || cp > 0x10ffff) return ' '
  if (cp >= 0xd800 && cp <= 0xdfff) return ' '
  return String.fromCodePoint(cp)
}

function deobfuscate(html: string): string {
  let s = html
    // HTML numeric entities (decimal + hex)
    .replace(/&#(\d+);/g, (_, n) => safeFromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeFromCodePoint(parseInt(n, 16)))
    // Common named entities relevant to contacts
    .replace(/&amp;/gi, '&')
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    // Bracketed obfuscations — safe to replace globally
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\{\s*at\s*\}\s*/gi, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    .replace(/\s*\{\s*dot\s*\}\s*/gi, '.')

  // Bare-word " at " / " dot " — only when surrounded by email-shape:
  //   user(spaces)at(spaces)domain(spaces)dot(spaces)tld[(space)dot(space)tld]
  s = s.replace(
    /\b([A-Za-z0-9._-]+)\s+at\s+([A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+)\b/gi,
    (_, user, rest) => `${user}@${rest.replace(/\s+dot\s+/gi, '.')}`,
  )

  return s
}

export function extractContacts(html: string, baseUrl: string): ContactResult {
  if (!html) {
    return { emails: [], phones: [], contactPageUrl: null, raw: { emailCandidates: 0, phoneCandidates: 0, mailtoCount: 0 } }
  }

  // Run the de-obfuscation pre-pass before any regex extraction.
  const decoded = deobfuscate(html)

  const emails = new Set<string>()
  let mailtoCount = 0

  for (const m of decoded.matchAll(MAILTO_RE)) {
    if (!m[1]) continue
    mailtoCount++
    // RFC 6068: mailto local-parts may be percent-encoded (`User%40…`
    // for `@`) and multiple recipients are comma- or semicolon-
    // separated. Without decoding, an encoded `%40` capture has no `@`
    // and `isPlausibleEmail` silently rejects it; without splitting,
    // a `mailto:a@b,c@d` capture has two `@`s and also fails. Both
    // cases drop legitimate contact-page emails to the LLM fallback.
    let decodedHref: string
    try {
      decodedHref = decodeURIComponent(m[1])
    } catch {
      decodedHref = m[1]
    }
    for (const raw of decodedHref.split(/[,;]/)) {
      const e = raw.trim().toLowerCase()
      if (e && isPlausibleEmail(e)) emails.add(e)
    }
  }

  // Plain-text emails — strip script/style/comment chunks first to cut noise
  const stripped = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  let emailCandidates = 0
  for (const m of stripped.match(EMAIL_RE) ?? []) {
    emailCandidates++
    const e = m.toLowerCase()
    if (isPlausibleEmail(e)) emails.add(e)
  }

  const phones = new Set<string>()
  for (const m of decoded.matchAll(TEL_RE)) {
    if (m[1]) phones.add(normalizePhone(m[1]))
  }
  let phoneCandidates = 0
  for (const m of stripped.match(PHONE_RE) ?? []) {
    phoneCandidates++
    const cleaned = normalizePhone(m)
    if (cleaned.replace(/\D/g, '').length >= 7) phones.add(cleaned)
  }

  let contactPageUrl: string | null = null
  for (const m of decoded.matchAll(CONTACT_LINK_RE)) {
    if (m[1]) {
      contactPageUrl = absolutize(m[1], baseUrl)
      break
    }
  }

  return {
    emails: Array.from(emails).slice(0, 20),
    phones: Array.from(phones).slice(0, 20),
    contactPageUrl,
    raw: { emailCandidates, phoneCandidates, mailtoCount },
  }
}

function isPlausibleEmail(e: string): boolean {
  const parts = e.split('@')
  if (parts.length !== 2) return false
  const [, dom] = parts as [string, string]
  const tld = dom.split('.').pop()?.toLowerCase()
  if (!tld || EXCLUDED_EMAIL_TLDS.has(tld)) return false
  if (COMMON_NOISE_DOMAINS.some(n => dom.includes(n))) return false
  return true
}

function normalizePhone(p: string): string {
  return p.replace(/\s+/g, ' ').trim()
}

function absolutize(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return href
  }
}
