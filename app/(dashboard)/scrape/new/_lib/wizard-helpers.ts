/**
 * Shared helpers for the New Scrape wizard (UI preview, admin-only).
 *
 * Pure functions only — safe to import from both server and client
 * components. Nothing here talks to the database.
 */

export type EngineKey =
  | 'google'
  | 'bing'
  | 'youtube'
  | 'twitch'
  | 'kick'
  | 'facebook'
  | 'tiktok'
  | 'snapchat'
  | 'telegram'

export type EngineDef = {
  key: EngineKey
  label: string
  /** Two-letter monogram shown in the icon tile. */
  mono: string
  /** Tile colour (Tailwind classes). Brand-ish, no logos needed. */
  tone: string
  /** SERP engines produce leads and go through the enrichment stages. */
  kind: 'serp' | 'social'
  hint: string
}

/** Order matters: it is the order of the icon grid. "Both" (Google + Bing)
 *  is intentionally not offered here — one engine per scrape. */
export const ENGINES: ReadonlyArray<EngineDef> = [
  { key: 'google', label: 'Google', mono: 'G', tone: 'bg-blue-50 text-blue-700 ring-blue-200', kind: 'serp', hint: 'Organic via Apify, ads via the VM browser' },
  { key: 'bing', label: 'Bing', mono: 'B', tone: 'bg-teal-50 text-teal-700 ring-teal-200', kind: 'serp', hint: 'Organic and ads via Apify. Not available for CH and IE' },
  { key: 'youtube', label: 'YouTube', mono: 'YT', tone: 'bg-red-50 text-red-700 ring-red-200', kind: 'social', hint: 'Channels, not leads' },
  { key: 'twitch', label: 'Twitch', mono: 'TW', tone: 'bg-violet-50 text-violet-700 ring-violet-200', kind: 'social', hint: 'Streamers, not leads' },
  { key: 'kick', label: 'Kick', mono: 'K', tone: 'bg-lime-50 text-lime-700 ring-lime-200', kind: 'social', hint: 'Streamers, not leads' },
  { key: 'facebook', label: 'Facebook', mono: 'FB', tone: 'bg-indigo-50 text-indigo-700 ring-indigo-200', kind: 'social', hint: 'Ad Library advertisers' },
  { key: 'tiktok', label: 'TikTok', mono: 'TT', tone: 'bg-zinc-100 text-zinc-800 ring-zinc-300', kind: 'social', hint: 'Creators, not leads' },
  { key: 'snapchat', label: 'Snapchat', mono: 'SC', tone: 'bg-yellow-50 text-yellow-700 ring-yellow-200', kind: 'social', hint: 'Creators, not leads' },
  { key: 'telegram', label: 'Telegram', mono: 'TG', tone: 'bg-sky-50 text-sky-700 ring-sky-200', kind: 'social', hint: 'Channels, not leads' },
]

export function engineDef(key: string | null | undefined): EngineDef | null {
  return ENGINES.find(e => e.key === key) ?? null
}

/** Countries where Bing has too little coverage; the server action drops
 *  Bing for these, so the wizard warns up front. */
export const BING_DISABLED_COUNTRIES: ReadonlySet<string> = new Set(['CH', 'IE'])

export const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  de: 'German',
  it: 'Italian',
  fr: 'French',
  da: 'Danish',
  no: 'Norwegian',
  nb: 'Norwegian',
  sl: 'Slovenian',
  sv: 'Swedish',
  fi: 'Finnish',
  nl: 'Dutch',
  pt: 'Portuguese',
  es: 'Spanish',
  pl: 'Polish',
  tr: 'Turkish',
  ja: 'Japanese',
}

export function langName(code: string): string {
  return LANG_NAMES[code] ?? code.toUpperCase()
}

/** Country languages plus English as a fallback, English first. */
export function langOptions(languages: string[] | null | undefined): string[] {
  const base = languages?.length ? [...languages] : ['en']
  const withEn = base.includes('en') ? base : ['en', ...base]
  return ['en', ...withEn.filter(l => l !== 'en')]
}

/** Regional-indicator emoji flag for an ISO 3166-1 alpha-2 code. */
export function flagEmoji(cc: string): string {
  const code = (cc || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return '🏳️'
  return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)))
}

/** Enrichment stages the user can pick. The Monday duplicate check always
 *  runs on insert, so it is not offered as a choice. */
export const ENRICHMENT_STAGES: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'affiliate', label: 'Affiliate detection', hint: 'Is the site an affiliate?' },
  { key: 'rooster', label: 'Rooster partner check', hint: 'Does it promote our brands?' },
  { key: 'stags', label: 'S-tag extraction', hint: 'Tracking tags on the CTA links' },
  { key: 'contacts', label: 'Contact extraction', hint: 'Emails, phones, contact page' },
]

export const SCHEDULE_TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Europe/Malta', label: 'Malta (CET/CEST)' },
  { value: 'Asia/Manila', label: 'Philippines (PHT)' },
  { value: 'Europe/London', label: 'UK (GMT/BST)' },
  { value: 'UTC', label: 'UTC' },
]

/** Interpret a `datetime-local` wall-clock string as if it were in `timeZone`
 *  and return the UTC ISO instant. Same logic as the current enqueue form. */
export function wallClockToUtcIso(local: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local)
  if (!m) return ''
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5])
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(utcGuess))
  const p: Record<string, number> = {}
  for (const part of parts) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const hour = p.hour === 24 ? 0 : (p.hour ?? h)
  const asZone = Date.UTC(p.year ?? y, (p.month ?? mo) - 1, p.day ?? d, hour, p.minute ?? mi)
  return new Date(utcGuess - (asZone - utcGuess)).toISOString()
}

/** UTC calendar day (YYYY-MM-DD) of an ISO instant. Quota days are UTC days. */
export function utcDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toISOString().slice(0, 10)
}

/** Split pasted text into distinct keywords: line breaks, commas or
 *  semicolons separate; trims; case-insensitive dedupe against `existing`. */
export function splitKeywords(text: string, existing: string[] = []): string[] {
  const seen = new Set(existing.map(k => k.toLowerCase()))
  const out: string[] = []
  for (const raw of text.split(/[\r\n;,]+/)) {
    const k = raw.trim().replace(/\s+/g, ' ')
    if (!k) continue
    const key = k.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(k)
  }
  return out
}

export const MAX_KEYWORDS = 200
export const MAX_KEYWORD_CHARS = 500

/** Milliseconds until the next UTC midnight (when the daily quota resets). */
export function msUntilUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(0, next - now.getTime())
}

export function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

/** Human label for a UTC day relative to today: Today, Tomorrow, or "Sep 19". */
export function dayLabel(day: string, today: string = utcDay(new Date())): string {
  if (day === today) return 'Today'
  const t = new Date(today + 'T00:00:00Z').getTime()
  const d = new Date(day + 'T00:00:00Z').getTime()
  if (d - t === 86_400_000) return 'Tomorrow'
  return new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** The shape the wizard hands to the (future) server action. Mirrors the
 *  fields `enqueueScrape` reads today, minus priority and "both". */
export type ScrapeDraft = {
  mode: 'now' | 'schedule'
  scheduled_at: string | null
  schedule_tz: string
  search_engine: EngineKey
  country_code: string
  language: string
  pages: number
  view_mode: 'both' | 'desktop' | 'mobile'
  keywords: string[]
  enrichment_stages: string[]
  with_enrichment: boolean
  top_n_by_follower: number | null
  duplicate_override: boolean
}

/** Per-day quota usage as loaded on the server. `used` counts distinct
 *  (keyword, country) pairs the user has queued for that UTC day. */
export type DayUsage = { day: string; used: number }

export type QuotaPreview = {
  /** Daily cap from system settings; null when caps are disabled. */
  cap: number | null
  /** True when this user bypasses the cap (admins). The wizard still shows
   *  the numbers so the UI can be tested, with a note. */
  exempt: boolean
  days: DayUsage[]
}

export type LastConfig = {
  search_engine: string
  country_code: string
  language: string
  pages: number
  view_mode: 'both' | 'desktop' | 'mobile'
  with_enrichment: boolean
  top_n_by_follower: number | null
  keywords: string[]
  created_at: string
}
