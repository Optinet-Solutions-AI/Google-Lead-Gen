import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import {
  ENABLED_SETTING_KEY,
  INTEGRATIONS,
  PROBE_SETTING_KEY,
  maskSecret,
  type IntegrationDef,
  type IntegrationKey,
  type IntegrationStatus,
  type ProbeRecord,
} from './registry'

/** Reads a jsonb system setting and returns it as a plain object. */
async function readObjectSetting<T extends Record<string, unknown>>(key: string): Promise<T> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', { p_key: key })
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as T
  return {} as T
}

/** Reads a jsonb system setting expected to hold a string secret. */
export async function readSecretSetting(key: string): Promise<string | null> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', { p_key: key })
  if (typeof data === 'string' && data.trim()) return data.trim()
  return null
}

function envValue(name: string): string | null {
  // Bracket access keeps this working for names that are not statically known.
  const v = process.env[name]
  return v && v.trim() ? v.trim() : null
}

/** Resolves one integration's configuration state without any network call. */
async function statusFor(
  def: IntegrationDef,
  enabledMap: Record<string, unknown>,
  probeMap: Record<string, unknown>,
): Promise<IntegrationStatus> {
  const warnings: string[] = []
  let configured = false
  let source: IntegrationStatus['source'] = 'missing'
  let masked: string | null = null
  const envPresent: string[] = []
  let envShadowsDb = false

  if (def.secret.kind === 'none') {
    configured = true
    source = 'not needed'
  } else if (def.secret.kind === 'env') {
    const real = def.secret.envNames.filter(n => !n.startsWith('('))
    for (const n of real) if (envValue(n)) envPresent.push(n)
    // A pure-env integration counts as configured when every named var is set.
    configured = real.length > 0 ? envPresent.length === real.length : true
    source = configured ? 'environment' : 'missing'
    if (real.length > 0 && envPresent.length > 0 && envPresent.length < real.length) {
      warnings.push(`Only ${envPresent.join(', ')} is set. Missing: ${real.filter(n => !envPresent.includes(n)).join(', ')}.`)
    }
    if (real.length === 0) {
      configured = true
      source = 'not needed'
    }
  } else {
    const dbValue = await readSecretSetting(def.secret.settingKey)
    const fallbacks = def.secret.envFallback ?? []
    for (const n of fallbacks) if (envValue(n)) envPresent.push(n)
    const envFirst = envPresent.length > 0 ? envValue(envPresent[0]!) : null

    if (dbValue) {
      configured = true
      source = 'database'
      masked = maskSecret(dbValue)
      if (envFirst) {
        envShadowsDb = true
        warnings.push(
          `An environment variable (${envPresent.join(', ')}) is also set. The VM reads the environment first, so the value saved here may not be the one in use.`,
        )
      }
    } else if (envFirst) {
      configured = true
      source = 'environment'
      masked = maskSecret(envFirst)
    }

    // Known naming trap: the OpenAI key saved under a name nothing reads.
    if (def.key === 'openai' && !configured) {
      const misnamed = envValue('OPENAI_APIKEY')
      if (misnamed) {
        warnings.push('OPENAI_APIKEY is set but the application code reads OPENAI_API_KEY. Save the key below, or rename the variable.')
      }
    }
  }

  const enabledRaw = enabledMap[def.key]
  const enabled = enabledRaw === undefined ? true : enabledRaw !== false
  if (!enabled) warnings.push('Disabled here. Features that depend on it are marked unavailable.')

  const probeRaw = probeMap[def.key]
  let lastProbe: ProbeRecord | null = null
  if (probeRaw && typeof probeRaw === 'object') {
    const p = probeRaw as Partial<ProbeRecord>
    if (typeof p.at === 'string' && typeof p.ok === 'boolean') {
      lastProbe = { at: p.at, ok: p.ok, detail: typeof p.detail === 'string' ? p.detail : '' }
    }
  }

  return { key: def.key, configured, source, masked, envPresent, envShadowsDb, enabled, lastProbe, warnings }
}

/** Configuration state for every integration. No network calls. */
export async function loadIntegrationStatuses(): Promise<Record<IntegrationKey, IntegrationStatus>> {
  const [enabledMap, probeMap] = await Promise.all([
    readObjectSetting(ENABLED_SETTING_KEY),
    readObjectSetting(PROBE_SETTING_KEY),
  ])
  const entries = await Promise.all(INTEGRATIONS.map(d => statusFor(d, enabledMap, probeMap)))
  const out = {} as Record<IntegrationKey, IntegrationStatus>
  for (const e of entries) out[e.key] = e
  return out
}

// ---------------------------------------------------------------- probes ----

export type ProbeResult = { ok: boolean; detail: string }

const PROBE_TIMEOUT_MS = 12_000

async function withTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves the secret actually in force for a DB-backed integration. */
async function effectiveSecret(def: IntegrationDef): Promise<string | null> {
  if (def.secret.kind === 'db') {
    for (const n of def.secret.envFallback ?? []) {
      const v = envValue(n)
      if (v) return v
    }
    return readSecretSetting(def.secret.settingKey)
  }
  return null
}

/** Makes one real call per integration and reports what came back. */
export async function probeIntegration(key: IntegrationKey): Promise<ProbeResult> {
  const def = INTEGRATIONS.find(i => i.key === key)
  if (!def) return { ok: false, detail: 'Unknown integration.' }

  try {
    switch (key) {
      case 'supabase': {
        const svc = createServiceClient()
        const { error, count } = await svc
          .from('gologin_profiles')
          .select('country_code', { count: 'exact', head: true })
        if (error) return { ok: false, detail: error.message }
        return { ok: true, detail: `Connected. ${count ?? 0} country profiles.` }
      }
      case 'apify': {
        const token = await effectiveSecret(def)
        if (!token) return { ok: false, detail: 'No token configured.' }
        const res = await withTimeout(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`)
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from Apify.` }
        const body = (await res.json()) as { data?: { username?: string; plan?: { id?: string } } }
        return { ok: true, detail: `Signed in as ${body.data?.username ?? 'unknown'}${body.data?.plan?.id ? ` on the ${body.data.plan.id} plan` : ''}.` }
      }
      case 'gologin': {
        const token = envValue('GOLOGIN_API_TOKEN')
        if (!token) return { ok: false, detail: 'GOLOGIN_API_TOKEN is not set for the web app.' }
        const base = envValue('GOLOGIN_API_URL') ?? 'https://api.gologin.com'
        const res = await withTimeout(`${base}/browser/v2`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from GoLogin.` }
        const body = (await res.json()) as unknown
        const list = Array.isArray(body) ? body : ((body as { profiles?: unknown[] })?.profiles ?? [])
        return { ok: true, detail: `Reachable. ${Array.isArray(list) ? list.length : 0} browser profiles on the account.` }
      }
      case 'twocaptcha': {
        const token = await effectiveSecret(def)
        if (!token) return { ok: false, detail: 'No API key configured.' }
        const res = await withTimeout(`https://2captcha.com/res.php?key=${encodeURIComponent(token)}&action=getbalance&json=1`)
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from 2Captcha.` }
        const body = (await res.json()) as { status?: number; request?: string }
        if (body.status !== 1) return { ok: false, detail: `2Captcha rejected the key: ${body.request ?? 'unknown error'}.` }
        return { ok: true, detail: `Key valid. Balance $${body.request}.` }
      }
      case 'monday': {
        const token = envValue('MONDAY_API_TOKEN')
        if (!token) return { ok: false, detail: 'MONDAY_API_TOKEN is not set.' }
        const url = envValue('MONDAY_API_URL') ?? 'https://api.monday.com/v2'
        const res = await withTimeout(url, {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ me { name email } }' }),
        })
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from Monday.` }
        const body = (await res.json()) as { data?: { me?: { name?: string; email?: string } }; errors?: Array<{ message?: string }> }
        if (body.errors?.length) return { ok: false, detail: body.errors[0]?.message ?? 'Monday returned an error.' }
        return { ok: true, detail: `Signed in as ${body.data?.me?.name ?? body.data?.me?.email ?? 'unknown'}.` }
      }
      case 'openai': {
        const token = await effectiveSecret(def)
        if (!token) return { ok: false, detail: 'No API key configured.' }
        const res = await withTimeout('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${token}` } })
        if (res.status === 401) return { ok: false, detail: 'OpenAI rejected the key (401).' }
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from OpenAI.` }
        const body = (await res.json()) as { data?: unknown[] }
        return { ok: true, detail: `Key valid. ${body.data?.length ?? 0} models available.` }
      }
      case 'hunter': {
        const token = await effectiveSecret(def)
        if (!token) return { ok: false, detail: 'No API key configured.' }
        const res = await withTimeout(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(token)}`)
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from Hunter.` }
        const body = (await res.json()) as { data?: { requests?: { searches?: { used?: number; available?: number } } } }
        const s = body.data?.requests?.searches
        return { ok: true, detail: s ? `Key valid. ${s.used ?? 0} of ${s.available ?? 0} searches used.` : 'Key valid.' }
      }
      case 'translate': {
        const res = await withTimeout('https://api.mymemory.translated.net/get?q=test&langpair=de|en')
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from MyMemory.` }
        return { ok: true, detail: 'Reachable. No key required.' }
      }
      case 'vm_health': {
        const url = envValue('VM_HEALTH_URL')
        if (!url) return { ok: false, detail: 'VM_HEALTH_URL is not set.' }
        const token = envValue('VM_HEALTH_TOKEN')
        const res = await withTimeout(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from the VM.` }
        return { ok: true, detail: 'VM answered its health check.' }
      }
      case 'pms': {
        const base = envValue('PMS_API_BASE')
        if (!base) return { ok: false, detail: 'PMS_API_BASE is not set.' }
        const token = envValue('PMS_API_TOKEN')
        const res = await withTimeout(base.replace(/\/$/, ''), token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
        return res.ok || res.status === 404
          ? { ok: true, detail: `Reachable (HTTP ${res.status}).` }
          : { ok: false, detail: `HTTP ${res.status} from PMS.` }
      }
      case 'proxy':
        return { ok: false, detail: 'Proxies are configured inside each GoLogin profile and cannot be tested from here.' }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, detail: msg.includes('abort') ? 'Timed out after 12 seconds.' : msg.slice(0, 200) }
  }
  return { ok: false, detail: 'No probe defined.' }
}

// ------------------------------------------------- GoLogin profile drift ----

export type DriftRow = {
  country_code: string
  country_name: string
  is_active: boolean
  db_profile_id: string | null
  db_display_name: string | null
  /** Name GoLogin currently reports for that id. */
  live_name: string | null
  state: 'ok' | 'no_id' | 'missing_in_gologin' | 'name_changed' | 'unknown'
}

export type DriftReport = {
  ok: boolean
  detail: string
  checkedAt: string
  rows: DriftRow[]
  /** Profiles on the GoLogin account that no country row points at. */
  unmapped: Array<{ id: string; name: string }>
}

export const DRIFT_SETTING_KEY = 'gologin_drift_last_check'

/**
 * Compares `gologin_profiles` against the live GoLogin account so an admin
 * can see when a browser profile was renamed, deleted or never linked.
 */
export async function checkGoLoginDrift(): Promise<DriftReport> {
  const checkedAt = new Date().toISOString()
  const svc = createServiceClient()
  const { data: rowsRaw, error } = await svc
    .from('gologin_profiles')
    .select('country_code, country_name, is_active, gologin_profile_id, gologin_display_name')
    .order('country_name', { ascending: true })
  if (error) return { ok: false, detail: error.message, checkedAt, rows: [], unmapped: [] }

  const rows = (rowsRaw ?? []) as Array<{
    country_code: string
    country_name: string
    is_active: boolean
    gologin_profile_id: string | null
    gologin_display_name: string | null
  }>

  const token = envValue('GOLOGIN_API_TOKEN')
  const base = envValue('GOLOGIN_API_URL') ?? 'https://api.gologin.com'
  if (!token) {
    return {
      ok: false,
      detail: 'GOLOGIN_API_TOKEN is not available to the web app, so only the local rows are shown.',
      checkedAt,
      rows: rows.map(r => ({
        country_code: r.country_code,
        country_name: r.country_name,
        is_active: r.is_active,
        db_profile_id: r.gologin_profile_id,
        db_display_name: r.gologin_display_name,
        live_name: null,
        state: r.gologin_profile_id ? 'unknown' : 'no_id',
      })),
      unmapped: [],
    }
  }

  let live: Array<{ id: string; name: string }> = []
  try {
    const res = await withTimeout(`${base}/browser/v2`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as unknown
    const arr = Array.isArray(body) ? body : ((body as { profiles?: unknown[] })?.profiles ?? [])
    live = (Array.isArray(arr) ? arr : [])
      .map(p => p as { id?: string; _id?: string; name?: string })
      .map(p => ({ id: String(p.id ?? p._id ?? ''), name: String(p.name ?? '') }))
      .filter(p => p.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      detail: `Could not reach GoLogin: ${msg.slice(0, 160)}`,
      checkedAt,
      rows: rows.map(r => ({
        country_code: r.country_code,
        country_name: r.country_name,
        is_active: r.is_active,
        db_profile_id: r.gologin_profile_id,
        db_display_name: r.gologin_display_name,
        live_name: null,
        state: r.gologin_profile_id ? 'unknown' : 'no_id',
      })),
      unmapped: [],
    }
  }

  const byId = new Map(live.map(p => [p.id, p.name]))
  const mapped = new Set<string>()
  const out: DriftRow[] = rows.map(r => {
    if (!r.gologin_profile_id) {
      return {
        country_code: r.country_code,
        country_name: r.country_name,
        is_active: r.is_active,
        db_profile_id: null,
        db_display_name: r.gologin_display_name,
        live_name: null,
        state: 'no_id',
      }
    }
    mapped.add(r.gologin_profile_id)
    const liveName = byId.get(r.gologin_profile_id) ?? null
    let state: DriftRow['state'] = 'ok'
    if (liveName === null) state = 'missing_in_gologin'
    else if (r.gologin_display_name && liveName.trim() !== r.gologin_display_name.trim()) state = 'name_changed'
    return {
      country_code: r.country_code,
      country_name: r.country_name,
      is_active: r.is_active,
      db_profile_id: r.gologin_profile_id,
      db_display_name: r.gologin_display_name,
      live_name: liveName,
      state,
    }
  })

  const unmapped = live.filter(p => !mapped.has(p.id))
  const problems = out.filter(r => r.state !== 'ok').length
  return {
    ok: true,
    detail: problems === 0 ? `All ${out.length} country profiles match GoLogin.` : `${problems} of ${out.length} country profiles disagree with GoLogin.`,
    checkedAt,
    rows: out,
    unmapped,
  }
}

// ------------------------------------------------ Google login accounts ----

export type GoogleLoginRow = {
  country_code: string
  country_name: string
  requires_login: boolean
  is_logged_in: boolean
  verified_at: string | null
  has_credential: boolean
  email: string | null
  last_used_at: string | null
  last_used_status: string | null
  /** Derived: what an operator should do about this row. */
  state: 'ok' | 'never_used' | 'stale' | 'failing' | 'missing_credential' | 'not_required'
  ageDays: number | null
}

const STALE_AFTER_DAYS = 14

/** Health of the stored Google sign-in accounts, per country. */
export async function loadGoogleLoginHealth(nowMs: number): Promise<GoogleLoginRow[]> {
  const svc = createServiceClient()
  const [profilesRes, credsRes] = await Promise.all([
    svc
      .from('gologin_profiles')
      .select('country_code, country_name, requires_google_login, is_google_logged_in, google_login_verified_at')
      .eq('is_active', true)
      .order('country_name', { ascending: true }),
    svc
      .from('google_login_credentials')
      .select('country_code, email, last_used_at, last_used_status')
      .eq('is_active', true),
  ])

  const profiles = (profilesRes.data ?? []) as Array<{
    country_code: string
    country_name: string
    requires_google_login: boolean
    is_google_logged_in: boolean
    google_login_verified_at: string | null
  }>
  const creds = new Map(
    ((credsRes.data ?? []) as Array<{ country_code: string; email: string; last_used_at: string | null; last_used_status: string | null }>).map(c => [c.country_code, c]),
  )

  return profiles.map(p => {
    const c = creds.get(p.country_code) ?? null
    const lastTouch = c?.last_used_at ?? p.google_login_verified_at ?? null
    const ageDays = lastTouch ? Math.floor((nowMs - new Date(lastTouch).getTime()) / 86_400_000) : null
    let state: GoogleLoginRow['state']
    if (!p.requires_google_login) state = 'not_required'
    else if (!c) state = 'missing_credential'
    else if ((c.last_used_status ?? '').toLowerCase().includes('fail') || (c.last_used_status ?? '').toLowerCase().includes('error')) state = 'failing'
    else if (lastTouch === null) state = 'never_used'
    else if (ageDays !== null && ageDays > STALE_AFTER_DAYS) state = 'stale'
    else state = 'ok'

    return {
      country_code: p.country_code,
      country_name: p.country_name,
      requires_login: p.requires_google_login,
      is_logged_in: p.is_google_logged_in,
      verified_at: p.google_login_verified_at,
      has_credential: !!c,
      email: c?.email ?? null,
      last_used_at: c?.last_used_at ?? null,
      last_used_status: c?.last_used_status ?? null,
      state,
      ageDays,
    }
  })
}
