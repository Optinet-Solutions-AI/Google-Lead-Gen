import 'server-only'

/**
 * AI website analysis — fetching, link extraction, CTA unmasking and the two
 * OpenAI calls. Orchestration and persistence live in ./run.ts.
 *
 * The division of labour here is the whole lesson of the 2026-09-18 test:
 *
 *   curl (this file)  fetches the page and finds + resolves the CTA links.
 *   OpenAI            judges the CONTENT: is it an affiliate, which brands,
 *                     which of ours, contact details.
 *
 * Two things we deliberately do NOT do, both measured:
 *   - We never let OpenAI open the page itself. Its web_search tool with an
 *     allowed_domains filter *searches* rather than fetches, so unindexed
 *     sites failed 15 of 19 times and each call is billed at $0.01. Fetching
 *     here succeeded on 37 of 51 and cost ~10x less.
 *   - We never ask the model for the CTA hrefs. It cannot tell which link
 *     belongs to which brand when the button is a logo or says only "Get
 *     bonus" — it returned null for all 25 brands on a page whose HTML held
 *     30 `/go/<brand>` links. Extracting in code and matching the brand from
 *     the link slug attributed 170 of 177.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

/** gpt-5-mini list price, $ per 1M tokens. */
const RATE = { input: 0.25, cachedInput: 0.025, output: 2.0 }

export type Usage = { input: number; cached: number; output: number }

export const costOf = (u: Usage): number =>
  ((u.input - u.cached) * RATE.input + u.cached * RATE.cachedInput + u.output * RATE.output) / 1_000_000

export const hostOf = (u: string): string => {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' }
}

// ---------------------------------------------------------------- fetch ----

export type PageLink = { href: string; label: string }
export type PageFetch = {
  status: 'ok' | 'blocked' | 'error'
  finalUrl: string
  text: string
  links: PageLink[]
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const c = parseInt(n, 10)
      return c >= 32 && c <= 0x10ffff ? String.fromCodePoint(c) : ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Anchors with their visible label, plus data-* attributes that carry the
 *  real destination on cloaked buttons. */
export function extractLinks(html: string, base: string): PageLink[] {
  const out: PageLink[] = []
  const seen = new Set<string>()
  const push = (href: string, label: string) => {
    const h = href.trim()
    if (!h || h.startsWith('#') || /^(javascript|mailto|tel|sms):/i.test(h)) return
    let abs: string
    try { abs = new URL(h, base).toString() } catch { return }
    if (seen.has(abs)) return
    seen.add(abs)
    out.push({ href: h, label: htmlToText(label).slice(0, 80) })
  }
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchor.exec(html)) !== null && out.length < 400) {
    const href = /\bhref\s*=\s*("|')(.*?)\1/i.exec(m[1] ?? '')?.[2] ?? ''
    push(href, m[2] ?? '')
  }
  const dataAttr = /\b(?:data-(?:urid|href|url|link|redirect|out|go|goto|to|target|cta|play|visit|offer|deal|aff|track|ref))\s*=\s*("|')(.*?)\1/gi
  while ((m = dataAttr.exec(html)) !== null && out.length < 500) push(m[2] ?? '', '(data attribute)')
  return out
}

export async function fetchPage(url: string, timeoutMs = 25_000): Promise<PageFetch> {
  let current = url
  for (let hop = 0; hop < 5; hop++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(current, { headers: HEADERS, redirect: 'manual', signal: ctrl.signal })
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString()
        continue
      }
      if (res.status === 403 || res.status === 429) return { status: 'blocked', finalUrl: current, text: '', links: [] }
      if (res.status >= 400) return { status: 'error', finalUrl: current, text: '', links: [] }
      const html = await res.text()
      return {
        status: 'ok',
        finalUrl: current,
        text: htmlToText(html).slice(0, 18_000),
        links: extractLinks(html, current),
      }
    } catch {
      return { status: 'error', finalUrl: current, text: '', links: [] }
    } finally {
      clearTimeout(timer)
    }
  }
  return { status: 'error', finalUrl: current, text: '', links: [] }
}

// ------------------------------------------------------------------ CTA ----

/** Same-host paths that are outbound redirects in disguise.
 *
 *  Deliberately narrow. An earlier, broader list included content words like
 *  `bonus`, `offers` and `play`, which matched ordinary category pages
 *  (`/bonuses/free-spins/`) and inflated the CTA count on review sites. Only
 *  prefixes that exist to bounce a visitor somewhere else belong here, and
 *  they must be followed by a single slug — `/go/leovegas`, not `/go/uk/best`. */
export const CTA_CLOAK =
  /\/(go|goto|out|visit|redirect|redir|rd|aff|affiliate|partner|partners|track|click|away|ext|external|ref|urid|link)\/[^/?#]+\/?(\?|#|$)/i

/** Outbound hosts that are never a casino CTA: social, regulators,
 *  responsible-gambling bodies, testing labs, payment providers, software
 *  vendors and ordinary page furniture. */
export const NOISE_HOST =
  /(facebook|instagram|twitter|x\.com|linkedin|youtube|youtu\.be|tiktok|pinterest|reddit|t\.me|telegram|whatsapp|wa\.me|threads|vk\.com|trustpilot|wikipedia|wikimedia|browsehappy|gravatar|googleapis|gstatic|google\.|bing\.|cloudflare|jquery|w3\.org|schema\.org|addtoany|sharethis|gambleaware|begambleaware|gamcare|gamstop|gamblingtherapy|hjelpelinjen|spelpaus|pgf\.nz|jocresponsabil|responsiblegambling|gamblingcommission|mga\.org\.mt|curacao-egaming|onjn\.gov|spelinspektionen|kansspelautoriteit|adm\.gov|anj\.fr|spillemyndigheden|ecogra|itechlabs|gaminglabs|legislation\.govt|dia\.govt|\.gov(\.|$)|europa\.eu|casinomeister|askgamblers|apple\.com|play\.google|assetcdn|cdn\.)/i

/** Payment, KYC and games-supplier hosts. Affiliates link to these as trust
 *  signals ("we accept Trustly", "games by Pragmatic Play") — they are not
 *  brand CTAs and they were padding the counts. */
export const NOISE_VENDOR_HOST =
  /(trustly|skrill|neteller|paysafecard|paysafe|paypal|visa\.|mastercard|maestro|revolut|klarna|zimpler|mifinity|jeton|ecopayz|astropay|interac|muchbetter|boku|sofort|giropay|ideal\.|bankid|stripe|adyen|worldpay|nuvei|coinbase|binance|blockchain\.com|pragmaticplay|playngo|netent|evolution(gaming)?\.|microgaming|yggdrasil|redtiger|nolimitcity|betsoft|quickspin|playtech|isoftbet|relaxgaming|thunderkick|bigtimegaming|push-?gaming|hacksaw)/i

/** Hostnames that prove the click runs through a Rooster tracker. */
export const ROOSTER_TRACKER = /(rooster-partner|roosters-partner|roosterspartners|rooster-partners)\./i

/** The links on a page that look like brand CTAs. */
export function ctaCandidates(page: PageFetch): PageLink[] {
  const selfHost = hostOf(page.finalUrl)
  return page.links.filter(l => {
    let abs: string
    try { abs = new URL(l.href, page.finalUrl).toString() } catch { return false }
    const h = hostOf(abs)
    if (h === selfHost) return CTA_CLOAK.test(l.href)
    return !NOISE_HOST.test(h) && !NOISE_VENDOR_HOST.test(h)
  })
}

/** A CTA has to leave the site. If the redirect chain lands back on the
 *  affiliate's own host it was an internal page, not an outbound brand link —
 *  the single most effective filter against inflated CTA counts. */
export function isOutboundCta(u: Unmasked, selfHost: string): boolean {
  const dest = u.host ?? ''
  if (!dest) return true // unresolved: keep it, the browser pass can decide
  if (dest === selfHost) return false
  // A site's own locale siblings (casinoble.ro -> casinoble.cz/.bg/.ee) are
  // language switchers, not brand CTAs.
  if (siteLabel(dest) === siteLabel(selfHost)) return false
  return !NOISE_HOST.test(dest) && !NOISE_VENDOR_HOST.test(dest)
}

/** The name part of a host, without subdomains or TLD: `casinoble.co.uk` and
 *  `www.casinoble.ro` both give `casinoble`. */
export function siteLabel(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ''
  // Drop a trailing multi-part TLD (.co.uk, .com.au) then take the last label.
  const tail = parts.slice(-2).join('.')
  const isCompound = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(tail)
  const idx = isCompound ? parts.length - 3 : parts.length - 2
  return parts[Math.max(0, idx)] ?? ''
}

/** Anchor text is only usable as a brand name when it reads like one. Review
 *  sites wrap CTAs in whole sentences ("See a list of bonus spins offers…"),
 *  which is not a brand. */
export function brandFromLabel(label: string | undefined): string | null {
  const t = (label ?? '').trim()
  if (!t || t.length > 40) return null
  if (t.split(/\s+/).length > 4) return null
  if (/^(hent|get|claim|play|visit|spill|besøk|bonus|spela|gioca|jouer|jugar|mehr|read|see|view|more|here|click|sign ?up|join|review)\b/i.test(t)) return null
  return t
}

export type Unmasked = {
  resolved: string | null
  host: string | null
  hops: number
  tracker: string | null
  status: 'ok' | 'blocked' | 'dead' | 'error'
  /** Every hop, so a tracking parameter on a middle hop is not lost when the
   *  final destination blocks us. */
  chain: string[]
}

/** Follow a CTA's redirect chain with plain HTTP. Never executes JavaScript,
 *  so a tag that only appears after a JS hop or inside a cookie still needs
 *  the VM's browser — that is the `stag` stage, not this. */
export async function unmask(raw: string, base: string, maxHops = 8, timeoutMs = 12_000): Promise<Unmasked> {
  let url: string
  try { url = new URL(raw, base).toString() } catch {
    return { resolved: null, host: null, hops: 0, tracker: null, status: 'error', chain: [] }
  }
  const chain: string[] = []
  let tracker: string | null = null
  for (let hops = 0; hops < maxHops; hops++) {
    chain.push(url)
    if (!tracker && ROOSTER_TRACKER.test(url)) tracker = hostOf(url)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      let res = await fetch(url, { method: 'HEAD', headers: HEADERS, redirect: 'manual', signal: ctrl.signal })
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { method: 'GET', headers: HEADERS, redirect: 'manual', signal: ctrl.signal })
      }
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString()
        continue
      }
      if (!tracker && ROOSTER_TRACKER.test(url)) tracker = hostOf(url)
      return {
        resolved: url,
        host: hostOf(url),
        hops,
        tracker,
        status: res.status < 400 ? 'ok' : res.status === 403 || res.status === 429 ? 'blocked' : 'dead',
        chain,
      }
    } catch {
      return { resolved: url, host: hostOf(url), hops, tracker, status: 'error', chain }
    } finally {
      clearTimeout(timer)
    }
  }
  return { resolved: url, host: hostOf(url), hops: maxHops, tracker, status: 'ok', chain }
}

/** Likely contact / imprint page on the same site. The landing page is often a
 *  category page, which is why the first test found 0 contact pages in 37. */
export function contactPageCandidate(page: PageFetch): string | null {
  const selfHost = hostOf(page.finalUrl)
  const WANT = /(contact|kontakt|contatti|contacto|contato|impressum|imprint|about-us|about|om-oss|chi-siamo|qui-sommes|nous-contacter)/i
  for (const l of page.links) {
    let abs: string
    try { abs = new URL(l.href, page.finalUrl).toString() } catch { continue }
    if (hostOf(abs) !== selfHost) continue
    if (WANT.test(abs) || WANT.test(l.label)) return abs
  }
  return null
}

// --------------------------------------------------------------- openai ----

export type OpenAIResult = { ok: boolean; status: number; parsed: unknown; usage: Usage }

export async function callOpenAI(
  key: string,
  body: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<OpenAIResult> {
  const usage: Usage = { input: 0, cached: 0, output: 0 }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json: Record<string, unknown> | null = null
    try { json = JSON.parse(text) as Record<string, unknown> } catch { /* keep raw */ }
    if (!json) return { ok: false, status: res.status, parsed: null, usage }

    const u = json.usage as
      | { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
      | undefined
    usage.input = u?.input_tokens ?? 0
    usage.cached = u?.input_tokens_details?.cached_tokens ?? 0
    usage.output = u?.output_tokens ?? 0

    let parsed: unknown = null
    for (const item of (json.output as Array<Record<string, unknown>>) ?? []) {
      if (item.type !== 'message') continue
      for (const c of (item.content as Array<Record<string, unknown>>) ?? []) {
        if (typeof c.text === 'string') {
          try { parsed = JSON.parse(c.text) } catch { /* not json */ }
        }
      }
    }
    return { ok: res.ok, status: res.status, parsed, usage }
  } catch {
    return { ok: false, status: 0, parsed: null, usage }
  } finally {
    clearTimeout(timer)
  }
}

const reasoningFor = (model: string) => (/^(gpt-5|o\d)/.test(model) ? { effort: 'low' } : undefined)

// ----- stage 1: triage (no page fetch) -----

const TRIAGE_INSTRUCTIONS = [
  'You screen websites for a team that hunts online-casino / sports-betting AFFILIATE sites: sites whose business is sending players to casino or bookmaker brands for commission (review listicles, "top 10 casinos", bonus aggregators, comparison pages with outbound tracking links, streamer link pages).',
  '',
  'You are given ONLY a domain and the search keywords it ranked for. Do NOT browse. Judge from the domain name, its shape, and the keywords.',
  '',
  'Set worth_checking = true when the site plausibly earns commission sending players to gambling brands, so it is worth paying to open and audit.',
  'Set worth_checking = false for: the casino / bookmaker OPERATOR itself (its own brand domain), news and media sites, regulators and government, responsible-gambling charities, payment providers, software vendors, forums and social platforms, shops, and anything clearly unrelated to gambling.',
  '',
  'When you are genuinely unsure, answer true — opening the page is cheap compared with missing a real affiliate. Reply strict JSON only.',
].join('\n')

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { worth_checking: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['worth_checking', 'reason'],
}

export type TriageVerdict = { worth: boolean; reason: string; usage: Usage; cost: number }

export async function triage(
  key: string,
  model: string,
  input: { domain: string; countryCode: string | null; keywords: string[] },
): Promise<TriageVerdict> {
  const body: Record<string, unknown> = {
    model,
    instructions: TRIAGE_INSTRUCTIONS,
    input: [
      `Domain: ${input.domain}`,
      `Country: ${input.countryCode ?? '?'}`,
      `Ranked for: ${input.keywords.slice(0, 6).join(' | ') || '(unknown)'}`,
    ].join('\n'),
    text: { format: { type: 'json_schema', name: 'triage', strict: true, schema: TRIAGE_SCHEMA } },
  }
  const r = reasoningFor(model)
  if (r) body.reasoning = r

  const res = await callOpenAI(key, body, 90_000)
  const p = res.parsed as { worth_checking?: boolean; reason?: string } | null
  // A failed screen must never silently drop a site.
  return {
    worth: p?.worth_checking ?? true,
    reason: p?.reason ?? (res.ok ? 'no verdict parsed' : `screen failed (${res.status})`),
    usage: res.usage,
    cost: costOf(res.usage),
  }
}

// ----- stage 2: content audit of the page WE fetched -----

export type Brand = { brand_name: string | null; domain: string }

export function auditInstructions(brands: Brand[]): string {
  const byName = new Map<string, string[]>()
  for (const b of brands) {
    const n = b.brand_name || b.domain
    byName.set(n, [...(byName.get(n) ?? []), b.domain])
  }
  const brandLines = [...byName.entries()].map(([n, ds]) => `- ${n} (${ds.join(', ')})`).join('\n')
  return [
    'You are an analyst auditing websites in the online-casino / sports-betting affiliate space. You are given the visible TEXT of one or two pages from a single site, and the list of LINKS found in the HTML (href followed by the link text). Judge only from what you are given. Do not browse.',
    '',
    "1. is_affiliate - true if the site's primary purpose is to drive traffic to OTHER casino or betting brands for commission (review listicles, \"top 10 casinos\", bonus aggregators, comparison pages with outbound CTAs / tracking links). A site that is itself a casino or bookmaker (login / deposit / withdraw) is NOT an affiliate. Pure responsible-gambling information with no brand promotion is NOT an affiliate. If the page could not be read, set null.",
    '',
    '2. rooster_brands_found - which of OUR brands (list below) the page promotes: a link to the brand domain, the brand name as a heading / button / logo caption / list entry in a clearly promotional context, or a "play at / claim bonus at / visit <Brand>" call to action. A brand name mentioned once inside a long list of many casinos with no special treatment does NOT count. Return the names EXACTLY as written in the list.',
    '',
    'OUR BRANDS:',
    brandLines,
    '',
    '3. brands - EVERY casino or betting brand the page displays, reviews, ranks, lists, compares or endorses. Give the brand name as shown on the page. Do not repeat a brand. Maximum 60. Do NOT return URLs — the links are extracted separately.',
    '',
    '4. emails / phones - public BUSINESS contact details for the SITE OPERATOR (contact, about, imprint / impressum, footer). Never invent; never include an email belonging to one of the casino brands being reviewed. The literal text "[email protected]" is a Cloudflare placeholder, NOT an address: never return it. If an address is obfuscated, omit it and set email_obfuscated true.',
    '',
    '5. contact_page_url - the canonical "Contact us" / imprint page URL on this site if one appears in the links, else null.',
    '',
    'Return strict JSON matching the schema. No prose.',
  ].join('\n')
}

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_affiliate: { type: ['boolean', 'null'] },
    affiliate_reasoning: { type: 'string' },
    rooster_brands_found: { type: 'array', items: { type: 'string' } },
    brands: { type: 'array', items: { type: 'string' } },
    emails: { type: 'array', items: { type: 'string' } },
    phones: { type: 'array', items: { type: 'string' } },
    email_obfuscated: { type: 'boolean' },
    contact_page_url: { type: ['string', 'null'] },
  },
  required: [
    'is_affiliate', 'affiliate_reasoning', 'rooster_brands_found', 'brands',
    'emails', 'phones', 'email_obfuscated', 'contact_page_url',
  ],
}

export type AuditVerdict = {
  is_affiliate: boolean | null
  affiliate_reasoning: string
  rooster_brands_found: string[]
  brands: string[]
  emails: string[]
  phones: string[]
  email_obfuscated: boolean
  contact_page_url: string | null
}

export async function audit(
  key: string,
  model: string,
  instructions: string,
  pages: Array<{ url: string; text: string }>,
  links: PageLink[],
): Promise<{ verdict: AuditVerdict | null; usage: Usage; cost: number; error?: string }> {
  const linkLines = links.slice(0, 150).map(l => `${l.href}  ||  ${l.label}`).join('\n')
  const input = [
    ...pages.flatMap(p => [`--- PAGE: ${p.url} ---`, p.text, '']),
    '--- LINKS ON THE PAGE (href || link text) ---',
    linkLines || '(none)',
  ].join('\n')

  const body: Record<string, unknown> = {
    model,
    instructions,
    input,
    text: { format: { type: 'json_schema', name: 'audit', strict: true, schema: AUDIT_SCHEMA } },
  }
  const r = reasoningFor(model)
  if (r) body.reasoning = r

  const res = await callOpenAI(key, body)
  if (!res.parsed) {
    return {
      verdict: null,
      usage: res.usage,
      cost: costOf(res.usage),
      error: res.ok ? 'no verdict parsed' : `HTTP ${res.status}`,
    }
  }
  return { verdict: res.parsed as AuditVerdict, usage: res.usage, cost: costOf(res.usage) }
}

/** Normalised form used to match a model-reported brand against a link slug. */
export const brandSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
