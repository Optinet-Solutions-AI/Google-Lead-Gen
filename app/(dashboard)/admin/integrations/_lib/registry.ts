import 'server-only'

/**
 * Registry of every third-party service this app and the VM depend on.
 *
 * The Integrations page reads this to show what is configured, where each
 * secret actually lives, and what stops working when one is missing. A
 * presence check runs on page load (cheap, local); a real network probe
 * only runs when an admin presses "Test".
 */

export type IntegrationKey =
  | 'supabase'
  | 'apify'
  | 'gologin'
  | 'twocaptcha'
  | 'monday'
  | 'openai'
  | 'hunter'
  | 'proxy'
  | 'translate'
  | 'vm_health'
  | 'pms'

export type SecretSource =
  /** Editable here; stored in `system_settings` and read by the app and the VM. */
  | { kind: 'db'; settingKey: string; envFallback?: string[] }
  /** Set in Vercel and on the VM; shown read-only here. */
  | { kind: 'env'; envNames: string[] }
  /** No credential needed. */
  | { kind: 'none' }

export type IntegrationDef = {
  key: IntegrationKey
  name: string
  /** One line: what it does for us. */
  purpose: string
  /** What breaks when it is unavailable. */
  breaks: string
  /** Where it is used, for the "currently being used" question. */
  usedBy: string[]
  secret: SecretSource
  /** Whether "Test" can make a real call. */
  probeable: boolean
  /** Required for the product to function at all. */
  critical: boolean
  docsUrl?: string
}

export const INTEGRATIONS: ReadonlyArray<IntegrationDef> = [
  {
    key: 'supabase',
    name: 'Supabase',
    purpose: 'Database, authentication and screenshot storage.',
    breaks: 'Everything. The app cannot load without it.',
    usedBy: ['Web app', 'VM workers', 'Scheduler'],
    secret: { kind: 'env', envNames: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] },
    probeable: true,
    critical: true,
  },
  {
    key: 'apify',
    name: 'Apify',
    purpose: 'Google and Bing organic search results.',
    breaks: 'Organic scraping falls back to the VM browser, which is slower and hits captchas.',
    usedBy: ['Google organic jobs', 'Bing jobs (organic + ads)'],
    secret: { kind: 'db', settingKey: 'apify_api_token', envFallback: ['APIFY_TOKEN'] },
    probeable: true,
    critical: true,
    docsUrl: 'https://console.apify.com/account/integrations',
  },
  {
    key: 'gologin',
    name: 'GoLogin',
    purpose: 'Anti-detect browser profiles, one per country, used by the VM.',
    breaks: 'Paid-ad scraping and every social engine. The VM cannot open a browser.',
    usedBy: ['VM scrape workers', 'VM enrichment workers', 'Country profiles'],
    secret: { kind: 'env', envNames: ['GOLOGIN_API_TOKEN', 'GOLOGIN_API_URL'] },
    probeable: true,
    critical: true,
    docsUrl: 'https://app.gologin.com/personalArea/TokenApi',
  },
  {
    key: 'twocaptcha',
    name: '2Captcha',
    purpose: 'Solves Google captcha walls automatically, matched to the proxy IP.',
    breaks: 'Captchas wait for a human through noVNC, or the job goes terminal.',
    usedBy: ['VM scrape workers'],
    secret: { kind: 'db', settingKey: 'twocaptcha_api_key', envFallback: ['TWOCAPTCHA_API_KEY'] },
    probeable: true,
    critical: false,
    docsUrl: 'https://2captcha.com/enterpage',
  },
  {
    key: 'monday',
    name: 'Monday.com',
    purpose: 'Source of known leads and brands; destination for pushed leads.',
    breaks: 'Duplicate detection, brand lists and Push to Monday.',
    usedBy: ['Monday sync', 'Lead inheritance', 'Push to Monday'],
    secret: { kind: 'env', envNames: ['MONDAY_API_TOKEN', 'MONDAY_API_URL'] },
    probeable: true,
    critical: true,
  },
  {
    key: 'openai',
    name: 'OpenAI',
    purpose: 'Affiliate and Rooster tie-breaking, plus contact extraction when the page scan finds nothing.',
    breaks: 'Those fallbacks silently do nothing and the heuristic verdict stands.',
    usedBy: ['Contact extraction fallback', 'Borderline affiliate classifier'],
    secret: { kind: 'db', settingKey: 'openai_api_key', envFallback: ['OPENAI_API_KEY', 'OPENAI_APIKEY'] },
    probeable: true,
    critical: false,
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'hunter',
    name: 'Hunter.io',
    purpose: 'Last-resort email lookup by domain.',
    breaks: 'Contact extraction stops after the page scan and the LLM fallback.',
    usedBy: ['Contact extraction tier 3'],
    secret: { kind: 'db', settingKey: 'hunter_api_key', envFallback: ['HUNTER_API_KEY'] },
    probeable: true,
    critical: false,
    docsUrl: 'https://hunter.io/api-keys',
  },
  {
    key: 'proxy',
    name: 'Residential proxy',
    purpose: 'Country-matched exit IPs for the VM browsers.',
    breaks: 'Every VM scrape fails its proxy check; results are geographically wrong.',
    usedBy: ['VM scrape workers', 'Captcha IP matching'],
    secret: { kind: 'env', envNames: ['(configured inside each GoLogin profile)'] },
    probeable: false,
    critical: true,
  },
  {
    key: 'translate',
    name: 'MyMemory translation',
    purpose: 'English copy of non-English keywords, shown beside the original.',
    breaks: 'Keywords simply have no English translation. Scraping is unaffected.',
    usedBy: ['Scrape enqueue'],
    secret: { kind: 'none' },
    probeable: true,
    critical: false,
  },
  {
    key: 'vm_health',
    name: 'VM health endpoint',
    purpose: 'Liveness and disk reporting from the scraping VM.',
    breaks: 'The fleet view cannot tell a dead VM from an idle one.',
    usedBy: ['Operations dashboard'],
    secret: { kind: 'env', envNames: ['VM_HEALTH_URL', 'VM_HEALTH_TOKEN'] },
    probeable: true,
    critical: false,
  },
  {
    key: 'pms',
    name: 'PMS (project tracker)',
    purpose: 'Task tracking for this project.',
    breaks: 'Nothing in the product. Internal planning only.',
    usedBy: ['Internal'],
    secret: { kind: 'env', envNames: ['PMS_API_BASE', 'PMS_API_TOKEN'] },
    probeable: true,
    critical: false,
  },
]

export function integrationDef(key: string): IntegrationDef | null {
  return INTEGRATIONS.find(i => i.key === key) ?? null
}

/** system_settings key holding `{ [integrationKey]: boolean }`. Absent = enabled. */
export const ENABLED_SETTING_KEY = 'integration_enabled'
/** system_settings key holding `{ [integrationKey]: { at, ok, detail } }`. */
export const PROBE_SETTING_KEY = 'integration_last_probe'

export type ProbeRecord = { at: string; ok: boolean; detail: string }

export type IntegrationStatus = {
  key: IntegrationKey
  /** A secret is present somewhere (DB or env), or none is needed. */
  configured: boolean
  /** Where the value actually came from. */
  source: 'database' | 'environment' | 'not needed' | 'missing'
  /** Masked form of the secret, never the secret itself. */
  masked: string | null
  /** Env var names that are set, for the shadowing warning. */
  envPresent: string[]
  /** True when both a DB value and an env var exist and the VM would prefer env. */
  envShadowsDb: boolean
  enabled: boolean
  lastProbe: ProbeRecord | null
  /** Config problems worth surfacing even when a value exists. */
  warnings: string[]
}

/** Masks a secret to a short, safe hint: length and last 4 characters. */
export function maskSecret(value: string): string {
  const v = value.trim()
  if (!v) return ''
  if (v.length <= 8) return `${'•'.repeat(Math.max(v.length - 2, 1))}${v.slice(-2)}`
  return `${'•'.repeat(8)}${v.slice(-4)} · ${v.length} chars`
}
