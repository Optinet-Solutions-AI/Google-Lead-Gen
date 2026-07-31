/**
 * Contact extractor v2 — regex + JSON-LD + anti-obfuscation, with
 * PER-ITEM provenance.
 *
 * Every contact returned carries how it was found (`method`), the page
 * URL it came from (`sourceUrl`), and a `confidence` — so operators can
 * see which tool/tier produced each email/phone/social and where.
 * (Baseline audit LGP-184: the old extractor returned flat arrays with
 * only a coarse table-level tier. This adds the attribution the whole
 * v2 epic hangs off.)
 *
 * What it finds:
 *   - emails: mailto hrefs, plain text, obfuscated ("at"/"dot"/entities)
 *   - phones: tel hrefs + text — VALIDATED via libphonenumber so casino
 *     bonus figures / IDs / dates stop counting as phones (the precision
 *     bug the audit surfaced: 14k "phones" ≈ 7/site was mostly garbage)
 *   - socials: Telegram / WhatsApp / Discord / X / LinkedIn / IG / FB
 *   - contact links: ALL contact-shaped anchors, ranked (best first)
 *   - contact forms: pages exposing a <form> with email/message fields
 *   - address + structured contacts from JSON-LD / schema.org
 *
 * Handles the multi-page HTML blob the enrichment worker produces
 * (pages separated by `<!-- PAGE: <url> -->`) so each item's sourceUrl
 * is the actual page it was found on, not just the homepage.
 */
import {
  isValidPhoneNumber as isValidWithMeta,
  parsePhoneNumberFromString as parseWithMeta,
  type MetadataJson,
} from 'libphonenumber-js/core'
import rawPhoneMetadata from 'libphonenumber-js/metadata.min.json'

// libphonenumber-js's default entry loads its own metadata internally, but
// under some ESM/CJS loaders (tsx, and depending on bundler interop) that
// internal require comes back double-wrapped as `{ default: … }`, which
// makes every isValidPhoneNumber() call throw. toE164()'s catch would
// swallow that and silently extract ZERO phones. Importing the /core API
// and handing it the metadata ourselves — normalising the possible
// default-wrap — makes phone validation deterministic in every runtime
// (Next.js server, the backfill script, and the test harness alike).
const PHONE_METADATA = (
  (rawPhoneMetadata as unknown as { countries?: unknown }).countries
    ? rawPhoneMetadata
    : (rawPhoneMetadata as unknown as { default: unknown }).default
) as MetadataJson

const EMAIL_RE = /[A-Z0-9_%+][A-Z0-9._%+-]{0,63}@[A-Z0-9.-]+\.[A-Z][A-Z0-9-]{1,62}/gi
const MAILTO_RE = /href=["']mailto:([^"'?]+)/gi
const TEL_RE = /href=["']tel:([^"']+)/gi
// Text-phone candidate: now ALSO allows dotted formats — precision is
// enforced downstream by libphonenumber validation, so we can afford a
// looser catch here (fixes the dotted-format recall gap without the
// old false-positive flood).
const PHONE_RE = /(?<!\d)(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/g
const CONTACT_LINK_RE = /href=["']([^"']*\b(contact|kontakt|contacto|contatti|contato|about|impressum|support|kundtjanst|help|reach-us)(?=[-_/.?#]|["'])[^"']*)["']/gi
const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi
const JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
const FORM_RE = /<form\b[\s\S]*?<\/form>/gi

const EXCLUDED_EMAIL_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'pdf', 'ico', 'woff', 'woff2'])
const COMMON_NOISE_DOMAINS = [
  'sentry.io', 'sentry-cdn.com', 'wixpress.com', 'wix.com', 'gtm.js',
  'googletagmanager.com', 'cookiebot.com', 'schema.org', 'example.com',
]

// Social platforms → host patterns. First match wins; we keep the full URL.
const SOCIAL_PLATFORMS: Array<{ platform: string; test: RegExp }> = [
  { platform: 'telegram', test: /(?:t\.me|telegram\.me|telegram\.org)\//i },
  { platform: 'whatsapp', test: /(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com\/send)/i },
  { platform: 'discord', test: /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\//i },
  { platform: 'x', test: /(?:twitter\.com|x\.com)\/(?!(?:intent|share|home|search)\b)[A-Za-z0-9_]{2,}/i },
  { platform: 'linkedin', test: /linkedin\.com\/(?:company|in)\//i },
  { platform: 'instagram', test: /instagram\.com\/[A-Za-z0-9_.]{2,}/i },
  { platform: 'facebook', test: /(?:facebook\.com|fb\.com)\/(?!(?:sharer|share|dialog|plugins)\b)[A-Za-z0-9.]{2,}/i },
]

export type ContactMethod =
  | 'mailto' | 'text-email' | 'obfuscated-email' | 'json-ld'
  | 'tel' | 'text-phone'
  | 'social-anchor'
  | 'contact-link' | 'contact-form'
  | 'address-json-ld'
  // Cascade tiers (set by the score-row route, not the regex extractor).
  | 'openai' | 'hunter' | 'manual'

export type ContactKind = 'email' | 'phone' | 'social' | 'contact_link' | 'contact_form' | 'address'

/** One extracted contact with full provenance. */
export type ContactItem = {
  kind: ContactKind
  value: string
  method: ContactMethod
  sourceUrl: string
  confidence: number
  label?: string
}

export type SocialLink = { platform: string; url: string; sourceUrl: string }

export type ContactResult = {
  // Back-compat flat arrays (existing callers/UI keep working).
  emails: string[]
  phones: string[]
  contactPageUrl: string | null
  // v2 additions.
  items: ContactItem[]
  socials: SocialLink[]
  contactLinks: string[]
  contactForms: string[]
  address: string | null
  raw: {
    emailCandidates: number
    phoneCandidates: number
    mailtoCount: number
    jsonLdBlocks: number
    pages: number
  }
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp)) return ' '
  if (cp < 0x20 || cp > 0x10ffff) return ' '
  if (cp >= 0xd800 && cp <= 0xdfff) return ' '
  return String.fromCodePoint(cp)
}

function deobfuscate(html: string): string {
  let s = html
    .replace(/&#(\d+);/g, (_, n) => safeFromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeFromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.')
  s = s.replace(
    /\b([A-Za-z0-9._-]+)\s+at\s+([A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+)\b/gi,
    (_, user, rest) => `${user}@${rest.replace(/\s+dot\s+/gi, '.')}`,
  )
  // Mixed form: the "at" was bracketed/entity-decoded above (so it's now a
  // literal @), but the "dot" was left spelled out — e.g. "user@acme dot
  // com". Only fires immediately after an @, so ordinary prose like "best
  // dot com sites" is never rewritten.
  s = s.replace(
    /@([A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+)/gi,
    (_, rest) => `@${rest.replace(/\s+dot\s+/gi, '.')}`,
  )
  return s
}

/** Split the enrichment worker's multi-page blob into {url, html} pages. */
function splitPages(html: string, baseUrl: string): Array<{ url: string; html: string }> {
  const marker = /<!--\s*PAGE:\s*([^\s>]+)\s*-->/g
  const idxs: Array<{ url: string; start: number }> = []
  let m: RegExpExecArray | null
  while ((m = marker.exec(html))) idxs.push({ url: m[1]!, start: m.index + m[0].length })
  if (idxs.length === 0) return [{ url: baseUrl, html }]
  const pages: Array<{ url: string; html: string }> = []
  for (let i = 0; i < idxs.length; i++) {
    const end = i + 1 < idxs.length ? idxs[i + 1]!.start : html.length
    pages.push({ url: idxs[i]!.url, html: html.slice(idxs[i]!.start, end) })
  }
  return pages
}

export function extractContacts(html: string, baseUrl: string): ContactResult {
  const empty: ContactResult = {
    emails: [], phones: [], contactPageUrl: null, items: [], socials: [],
    contactLinks: [], contactForms: [], address: null,
    raw: { emailCandidates: 0, phoneCandidates: 0, mailtoCount: 0, jsonLdBlocks: 0, pages: 0 },
  }
  if (!html) return empty

  const items: ContactItem[] = []
  const socials: SocialLink[] = []
  const contactLinks: Array<{ url: string; rank: number }> = []
  const contactForms = new Set<string>()
  let address: string | null = null
  let emailCandidates = 0, phoneCandidates = 0, mailtoCount = 0, jsonLdBlocks = 0

  const pages = splitPages(html, baseUrl)

  for (const page of pages) {
    const src = page.url
    const decoded = deobfuscate(page.html)
    const stripped = decoded
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')

    // --- Emails: mailto (high conf) ---
    for (const m of decoded.matchAll(MAILTO_RE)) {
      if (!m[1]) continue
      let href: string
      try { href = decodeURIComponent(m[1]) } catch { href = m[1] }
      let found = false
      for (const raw of href.split(/[,;]/)) {
        const e = raw.trim().toLowerCase()
        if (e && isPlausibleEmail(e)) { items.push({ kind: 'email', value: e, method: 'mailto', sourceUrl: src, confidence: 0.95 }); found = true }
      }
      if (found) mailtoCount++
    }
    // --- Emails: plain text (was the obfuscation decoded? tag accordingly) ---
    for (const raw of stripped.match(EMAIL_RE) ?? []) {
      emailCandidates++
      const e = raw.toLowerCase()
      if (!isPlausibleEmail(e)) continue
      // If this email only exists after de-obfuscation (not in the raw
      // page html), mark it obfuscated + lower confidence.
      const obfuscated = !page.html.toLowerCase().includes(e)
      items.push({ kind: 'email', value: e, method: obfuscated ? 'obfuscated-email' : 'text-email', sourceUrl: src, confidence: obfuscated ? 0.6 : 0.75 })
    }

    // --- Phones: tel hrefs (validated) ---
    for (const m of decoded.matchAll(TEL_RE)) {
      if (!m[1]) continue
      const e164 = toE164(m[1])
      if (e164) items.push({ kind: 'phone', value: e164, method: 'tel', sourceUrl: src, confidence: 0.9 })
    }
    // --- Phones: text (PRECISION — only libphonenumber-valid ones) ---
    for (const cand of stripped.match(PHONE_RE) ?? []) {
      phoneCandidates++
      const e164 = toE164(cand)
      if (e164) items.push({ kind: 'phone', value: e164, method: 'text-phone', sourceUrl: src, confidence: 0.65 })
    }

    // --- Anchors: socials + contact links ---
    for (const a of decoded.matchAll(ANCHOR_RE)) {
      const href = a[1]
      if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue
      const abs = absolutize(href, src)
      // social?
      const soc = SOCIAL_PLATFORMS.find(p => p.test.test(abs))
      if (soc) {
        socials.push({ platform: soc.platform, url: abs, sourceUrl: src })
        items.push({ kind: 'social', value: abs, method: 'social-anchor', sourceUrl: src, confidence: 0.9, label: soc.platform })
      }
    }
    // contact-shaped links (ranked) — reuse the dedicated regex
    for (const m of decoded.matchAll(CONTACT_LINK_RE)) {
      if (!m[1]) continue
      const abs = absolutize(m[1], src)
      contactLinks.push({ url: abs, rank: rankContactLink(m[2] ?? '', abs) })
    }

    // --- Contact forms ---
    for (const f of decoded.match(FORM_RE) ?? []) {
      if (/type=["']?email|name=["']?(email|message|name|contact)/i.test(f) || /<textarea/i.test(f)) {
        contactForms.add(src)
        items.push({ kind: 'contact_form', value: src, method: 'contact-form', sourceUrl: src, confidence: 0.8 })
        break
      }
    }

    // --- JSON-LD structured contacts ---
    for (const m of decoded.matchAll(JSONLD_RE)) {
      jsonLdBlocks++
      const parsed = tryParseJson(m[1] ?? '')
      if (!parsed) continue
      for (const node of flattenJsonLd(parsed)) {
        const email = typeof node.email === 'string' ? node.email.replace(/^mailto:/i, '').toLowerCase() : null
        if (email && isPlausibleEmail(email)) items.push({ kind: 'email', value: email, method: 'json-ld', sourceUrl: src, confidence: 0.95 })
        const tel = typeof node.telephone === 'string' ? node.telephone : null
        const e164 = tel ? toE164(tel) : null
        if (e164) items.push({ kind: 'phone', value: e164, method: 'json-ld', sourceUrl: src, confidence: 0.9 })
        const addr = formatAddress(node.address)
        if (addr && !address) { address = addr; items.push({ kind: 'address', value: addr, method: 'address-json-ld', sourceUrl: src, confidence: 0.9 }) }
        const same = Array.isArray(node.sameAs) ? node.sameAs : typeof node.sameAs === 'string' ? [node.sameAs] : []
        for (const url of same) {
          if (typeof url !== 'string') continue
          const soc = SOCIAL_PLATFORMS.find(p => p.test.test(url))
          if (soc) { socials.push({ platform: soc.platform, url, sourceUrl: src }); items.push({ kind: 'social', value: url, method: 'json-ld', sourceUrl: src, confidence: 0.95, label: soc.platform }) }
        }
      }
    }
  }

  // --- Dedupe (keep the highest-confidence provenance per value) ---
  const deduped = dedupeItems(items)

  // Ranked contact links (best first, unique).
  const linkSet = new Map<string, number>()
  for (const l of contactLinks) if (!linkSet.has(l.url) || linkSet.get(l.url)! < l.rank) linkSet.set(l.url, l.rank)
  const rankedLinks = [...linkSet.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])

  // Unique socials by URL.
  const socialSet = new Map<string, SocialLink>()
  for (const s of socials) if (!socialSet.has(s.url)) socialSet.set(s.url, s)

  const emails = uniq(deduped.filter(i => i.kind === 'email').map(i => i.value)).slice(0, 20)
  const phones = uniq(deduped.filter(i => i.kind === 'phone').map(i => i.value)).slice(0, 20)

  return {
    emails,
    phones,
    contactPageUrl: rankedLinks[0] ?? null,
    items: deduped.slice(0, 100),
    socials: [...socialSet.values()].slice(0, 20),
    contactLinks: rankedLinks.slice(0, 10),
    contactForms: [...contactForms].slice(0, 10),
    address,
    raw: { emailCandidates, phoneCandidates, mailtoCount, jsonLdBlocks, pages: pages.length },
  }
}

// ---------------------------------------------------------------------------

function dedupeItems(items: ContactItem[]): ContactItem[] {
  const byKey = new Map<string, ContactItem>()
  for (const it of items) {
    const key = `${it.kind}|${it.value.toLowerCase()}`
    const prev = byKey.get(key)
    if (!prev || it.confidence > prev.confidence) byKey.set(key, it)
  }
  // Sort: emails, phones, socials, links, forms, address; then confidence desc.
  const order: Record<ContactKind, number> = { email: 0, phone: 1, social: 2, contact_link: 3, contact_form: 4, address: 5 }
  return [...byKey.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.confidence - a.confidence)
}

function uniq<T>(a: T[]): T[] { return [...new Set(a)] }

function isPlausibleEmail(e: string): boolean {
  const parts = e.split('@')
  if (parts.length !== 2) return false
  const [local, dom] = parts as [string, string]
  if (!local || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  const tld = dom.split('.').pop()?.toLowerCase()
  if (!tld || EXCLUDED_EMAIL_TLDS.has(tld)) return false
  if (COMMON_NOISE_DOMAINS.some(n => dom.includes(n))) return false
  return true
}

/**
 * Validate + normalise a phone to E.164 using libphonenumber. Returns
 * null when it isn't a real phone — this is the precision gate that
 * stops bonus amounts / IDs / dates from being stored as phones. Tries
 * as-is (needs a country code / +) and is deliberately strict.
 */
function toE164(raw: string): string | null {
  const cleaned = raw.replace(/[^\d+]/g, ' ').replace(/\s+/g, ' ').trim()
  const digits = cleaned.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) return null
  try {
    const withPlus = cleaned.startsWith('+') ? cleaned : `+${digits}`
    if (isValidWithMeta(withPlus, PHONE_METADATA)) {
      const p = parseWithMeta(withPlus, PHONE_METADATA)
      if (p && p.isValid()) return p.number
    }
  } catch { /* not a phone */ }
  return null
}

function rankContactLink(keyword: string, url: string): number {
  const k = keyword.toLowerCase()
  const base = k.startsWith('contact') || k.startsWith('kontakt') || k.startsWith('contato') || k.startsWith('contact') ? 100
    : k.startsWith('contacto') || k.startsWith('contatti') ? 95
    : k === 'support' || k === 'help' ? 60
    : k === 'impressum' ? 55
    : k.startsWith('about') ? 40
    : 30
  // Prefer a dedicated /contact page over deep or query-laden URLs.
  const short = url.length < 60 ? 5 : 0
  return base + short
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s.trim()) } catch { return null }
}

/** Flatten JSON-LD into a list of nodes (handles @graph + arrays). */
function flattenJsonLd(root: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const visit = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      out.push(o)
      if (Array.isArray(o['@graph'])) (o['@graph'] as unknown[]).forEach(visit)
    }
  }
  visit(root)
  return out
}

function formatAddress(a: unknown): string | null {
  if (!a) return null
  if (typeof a === 'string') return a.trim() || null
  if (typeof a === 'object') {
    const o = a as Record<string, unknown>
    const parts = ['streetAddress', 'addressLocality', 'postalCode', 'addressRegion', 'addressCountry']
      .map(k => o[k]).filter(v => typeof v === 'string' && v.trim()) as string[]
    return parts.length ? parts.join(', ') : null
  }
  return null
}

function absolutize(href: string, baseUrl: string): string {
  try { return new URL(href, baseUrl).toString() } catch { return href }
}
