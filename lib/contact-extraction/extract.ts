/**
 * Regex-based contact extractor. First-iteration replacement for the
 * legacy GPT-4o + web_search pipeline. Catches ~80% of the easy cases
 * (mailto: links, plain emails, tel: links). Future iteration can
 * layer Claude on top for the harder ones.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const MAILTO_RE = /href=["']mailto:([^"'?]+)/gi
const TEL_RE = /href=["']tel:([^"']+)/gi
const PHONE_RE = /(?<!\d)(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/g
const CONTACT_LINK_RE = /href=["']([^"']*\b(contact|kontakt|about|impressum)[^"']*)["']/gi

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

export function extractContacts(html: string, baseUrl: string): ContactResult {
  if (!html) {
    return { emails: [], phones: [], contactPageUrl: null, raw: { emailCandidates: 0, phoneCandidates: 0, mailtoCount: 0 } }
  }

  const emails = new Set<string>()
  let mailtoCount = 0

  for (const m of html.matchAll(MAILTO_RE)) {
    if (m[1]) {
      const e = m[1].trim().toLowerCase()
      if (isPlausibleEmail(e)) emails.add(e)
      mailtoCount++
    }
  }

  // Plain-text emails — strip script/style/comment chunks first to cut noise
  const stripped = html
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
  for (const m of html.matchAll(TEL_RE)) {
    if (m[1]) phones.add(normalizePhone(m[1]))
  }
  let phoneCandidates = 0
  for (const m of stripped.match(PHONE_RE) ?? []) {
    phoneCandidates++
    const cleaned = normalizePhone(m)
    if (cleaned.replace(/\D/g, '').length >= 7) phones.add(cleaned)
  }

  let contactPageUrl: string | null = null
  for (const m of html.matchAll(CONTACT_LINK_RE)) {
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
