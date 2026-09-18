/**
 * Shared helpers for the New Scrape wizard.
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
  /** What this source returns, in two or three words, shown under the tile. */
  returns: string
  /** The full statement of what you get and where it is stored. */
  detail: string
}

/** Order matters: it is the order of the icon grid. "Both" (Google + Bing)
 *  is intentionally not offered here — one engine per scrape. */
export const ENGINES: ReadonlyArray<EngineDef> = [
  {
    key: 'google',
    label: 'Google',
    mono: 'G',
    tone: 'bg-blue-50 text-blue-700 ring-blue-200',
    kind: 'serp',
    returns: 'Organic only',
    detail: 'Returns organic search results only. Paid ads are gated by IP address and almost never come back, so expect no PPC rows.',
  },
  {
    key: 'bing',
    label: 'Bing',
    mono: 'B',
    tone: 'bg-teal-50 text-teal-700 ring-teal-200',
    kind: 'serp',
    returns: 'Organic and ads',
    detail: 'Returns organic results and paid ads in the same pass. Not available for Switzerland or Ireland, where coverage is too thin.',
  },
  {
    key: 'youtube',
    label: 'YouTube',
    mono: 'YT',
    tone: 'bg-red-50 text-red-700 ring-red-200',
    kind: 'social',
    returns: 'Channels',
    detail: 'Finds channels. They are stored as YouTube channels, never as leads, and no enrichment stage runs on them.',
  },
  {
    key: 'twitch',
    label: 'Twitch',
    mono: 'TW',
    tone: 'bg-violet-50 text-violet-700 ring-violet-200',
    kind: 'social',
    returns: 'Streamers',
    detail: 'Finds streamers. They are stored as Twitch streamers, never as leads, and no enrichment stage runs on them.',
  },
  {
    key: 'kick',
    label: 'Kick',
    mono: 'K',
    tone: 'bg-lime-50 text-lime-700 ring-lime-200',
    kind: 'social',
    returns: 'Streamers',
    detail: 'Finds streamers. They are stored as Kick streamers, never as leads, and no enrichment stage runs on them.',
  },
  {
    key: 'facebook',
    label: 'Facebook',
    mono: 'FB',
    tone: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    kind: 'social',
    returns: 'Advertisers',
    detail: 'Finds advertisers in the public Ad Library. They are stored as Facebook advertisers, never as leads. No login needed.',
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    mono: 'TT',
    tone: 'bg-zinc-100 text-zinc-800 ring-zinc-300',
    kind: 'social',
    returns: 'Creators',
    detail: 'Finds creators. They are stored as TikTok creators, never as leads, and no enrichment stage runs on them.',
  },
  {
    key: 'snapchat',
    label: 'Snapchat',
    mono: 'SC',
    tone: 'bg-yellow-50 text-yellow-700 ring-yellow-200',
    kind: 'social',
    returns: 'Creators',
    detail: 'Finds creators. They are stored as Snapchat creators, never as leads, and no enrichment stage runs on them.',
  },
  {
    key: 'telegram',
    label: 'Telegram',
    mono: 'TG',
    tone: 'bg-sky-50 text-sky-700 ring-sky-200',
    kind: 'social',
    returns: 'Channels',
    detail: 'Finds channels. They are stored as Telegram channels, never as leads, and no enrichment stage runs on them.',
  },
]

/** The source chosen when nothing has been picked yet. */
export const DEFAULT_ENGINE: EngineKey = 'google'

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

/** Enrichment stages the user can pick, in the order they run. */
export const ENRICHMENT_STAGES: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'monday', label: 'Already exists on Monday', hint: 'Matches each domain against the Monday boards and marks the ones already known.' },
  { key: 'affiliate', label: 'Affiliate detection', hint: 'Reads the page and decides whether it sells traffic to casino brands.' },
  { key: 'rooster', label: 'Rooster partner check', hint: 'Looks for our own brands being promoted on the page.' },
  { key: 'stags', label: 'S-tag extraction', hint: 'Follows the call-to-action links and reads the affiliate tracking tag.' },
  { key: 'contacts', label: 'Contact extraction', hint: 'Collects business emails, phone numbers and the contact page.' },
]

export const ALL_STAGE_KEYS: ReadonlyArray<string> = ENRICHMENT_STAGES.map(s => s.key)

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

/** A setup the user explicitly chose to save, kept in their own browser. */
export type SavedConfig = {
  savedAt: string
  search_engine: EngineKey
  country_code: string
  language: string
  pages: number
  view_mode: 'both' | 'desktop' | 'mobile'
  enrichment_stages: string[]
  with_enrichment: boolean
  top_n_by_follower: number | null
}

/** Everything the wizard needs to pick up exactly where it left off. */
export type WizardDraft = {
  v: 1
  stepIndex: number
  /** Steps the operator has actually answered. A default is only shown as
   *  chosen once its step appears here, so nothing looks done before it is. */
  touched: string[]
  mode: 'now' | 'schedule'
  scheduledAtLocal: string
  scheduleTz: string
  configChoice: 'new' | 'saved' | null
  engine: EngineKey
  country: string | null
  language: string
  pages: number
  viewMode: 'both' | 'desktop' | 'mobile'
  keywords: string[]
  enrichChoice: 'none' | 'stages'
  stages: string[]
  topChoice: 'all' | 'n' | null
  topN: number
  runAnyway: boolean
  saveConfig: boolean
}

const KEY_PREFIX = 'lg-new-scrape'

/** Storage keys are namespaced per user so two accounts on one machine
 *  never inherit each other's setup. */
export function draftKey(userKey: string): string {
  return `${KEY_PREFIX}-draft:${userKey}`
}
export function savedConfigKey(userKey: string): string {
  return `${KEY_PREFIX}-saved:${userKey}`
}
export function lastStagesKey(userKey: string): string {
  return `${KEY_PREFIX}-stages:${userKey}`
}

/** Reads and validates JSON from localStorage. Returns null on anything odd,
 *  including a private window where storage throws. */
export function readStored<T>(key: string, validate: (v: unknown) => T | null): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    return validate(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function writeStored(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked — the wizard still works, it just will not resume */
  }
}

export function clearStored(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

const VIEW_MODES = ['both', 'desktop', 'mobile'] as const

function isEngine(v: unknown): v is EngineKey {
  return typeof v === 'string' && ENGINES.some(e => e.key === v)
}

export function parseDraft(v: unknown): WizardDraft | null {
  if (!v || typeof v !== 'object') return null
  const d = v as Partial<WizardDraft>
  if (d.v !== 1) return null
  return {
    v: 1,
    stepIndex: typeof d.stepIndex === 'number' && d.stepIndex >= 0 ? d.stepIndex : 0,
    touched: Array.isArray(d.touched) ? d.touched.filter((s): s is string => typeof s === 'string') : [],
    mode: d.mode === 'schedule' ? 'schedule' : 'now',
    scheduledAtLocal: typeof d.scheduledAtLocal === 'string' ? d.scheduledAtLocal : '',
    scheduleTz: typeof d.scheduleTz === 'string' ? d.scheduleTz : 'Europe/Malta',
    configChoice: d.configChoice === 'saved' || d.configChoice === 'new' ? d.configChoice : null,
    engine: isEngine(d.engine) ? d.engine : DEFAULT_ENGINE,
    country: typeof d.country === 'string' ? d.country : null,
    language: typeof d.language === 'string' ? d.language : 'en',
    pages: typeof d.pages === 'number' && d.pages >= 1 && d.pages <= 10 ? d.pages : 1,
    viewMode: VIEW_MODES.includes(d.viewMode as (typeof VIEW_MODES)[number]) ? (d.viewMode as 'both' | 'desktop' | 'mobile') : 'both',
    keywords: Array.isArray(d.keywords) ? d.keywords.filter((k): k is string => typeof k === 'string').slice(0, MAX_KEYWORDS) : [],
    enrichChoice: d.enrichChoice === 'stages' ? 'stages' : 'none',
    stages: Array.isArray(d.stages) ? d.stages.filter((s): s is string => typeof s === 'string' && ALL_STAGE_KEYS.includes(s)) : [],
    topChoice: d.topChoice === 'n' || d.topChoice === 'all' ? d.topChoice : null,
    topN: typeof d.topN === 'number' && d.topN > 0 ? d.topN : 25,
    runAnyway: d.runAnyway === true,
    saveConfig: d.saveConfig === true,
  }
}

export function parseSavedConfig(v: unknown): SavedConfig | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Partial<SavedConfig>
  if (!isEngine(c.search_engine) || typeof c.country_code !== 'string' || !c.country_code) return null
  return {
    savedAt: typeof c.savedAt === 'string' ? c.savedAt : new Date().toISOString(),
    search_engine: c.search_engine,
    country_code: c.country_code,
    language: typeof c.language === 'string' ? c.language : 'en',
    pages: typeof c.pages === 'number' ? c.pages : 1,
    view_mode: VIEW_MODES.includes(c.view_mode as (typeof VIEW_MODES)[number]) ? (c.view_mode as 'both' | 'desktop' | 'mobile') : 'both',
    enrichment_stages: Array.isArray(c.enrichment_stages) ? c.enrichment_stages.filter((s): s is string => typeof s === 'string') : [],
    with_enrichment: c.with_enrichment === true,
    top_n_by_follower: typeof c.top_n_by_follower === 'number' ? c.top_n_by_follower : null,
  }
}

export function parseStageList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return v.filter((s): s is string => typeof s === 'string' && ALL_STAGE_KEYS.includes(s))
}
