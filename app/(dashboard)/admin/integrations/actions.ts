'use server'

import { revalidatePath } from 'next/cache'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/require-admin'
import { createServiceClient } from '@/lib/supabase/service'
import { ENABLED_SETTING_KEY, PROBE_SETTING_KEY, integrationDef, type IntegrationKey } from './_lib/registry'
import { checkGoLoginDrift, probeIntegration, type DriftReport } from './_lib/status'

export type ActionState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export type DriftState = { status: 'ok'; report: DriftReport } | { status: 'error'; error: string } | null

/** Reads a jsonb object setting, defaulting to `{}`. */
async function readObject(key: string): Promise<Record<string, unknown>> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', { p_key: key })
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
}

/**
 * Saves (or clears) a database-backed integration secret. The value is
 * written to `system_settings` through the same RPC the VM reads, and is
 * never echoed back to the browser.
 */
export async function saveSecretAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const key = String(fd.get('key') ?? '') as IntegrationKey
  const def = integrationDef(key)
  if (!def) return { status: 'error', error: 'Unknown integration.' }
  if (def.secret.kind !== 'db') return { status: 'error', error: `${def.name} is configured in the environment, not here.` }

  const raw = String(fd.get('value') ?? '').trim()
  const clearing = String(fd.get('clear') ?? '') === '1'

  if (!clearing) {
    if (!raw) return { status: 'error', error: 'Paste a value first.' }
    if (raw.length < 8) return { status: 'error', error: 'That looks too short to be a valid key.' }
    if (/\s/.test(raw)) return { status: 'error', error: 'The value contains spaces or line breaks. Paste the key only.' }
  }

  const svc = createServiceClient()
  const { error } = await svc.rpc('set_system_setting', {
    // The column is `jsonb not null`, so clearing writes an empty string
    // rather than a null. Every reader treats empty as "not configured".
    p_key: def.secret.settingKey,
    p_value: clearing ? '' : raw,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: clearing ? 'integrations.secret_clear' : 'integrations.secret_save',
    entity_type: 'system_setting',
    entity_id: null,
    // Never log the secret itself, only its shape.
    details: { integration: key, setting: def.secret.settingKey, length: clearing ? 0 : raw.length },
  })

  revalidatePath('/admin/integrations')
  return {
    status: 'ok',
    message: clearing
      ? `${def.name} key removed. The integration will read its environment variable if one is set.`
      : `${def.name} key saved. The VM picks it up on its next job.`,
  }
}

/** Turns an integration on or off for the whole team. */
export async function toggleIntegrationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const key = String(fd.get('key') ?? '') as IntegrationKey
  const def = integrationDef(key)
  if (!def) return { status: 'error', error: 'Unknown integration.' }
  const next = String(fd.get('value') ?? '').toLowerCase() === 'true'

  const current = await readObject(ENABLED_SETTING_KEY)
  const svc = createServiceClient()
  const { error } = await svc.rpc('set_system_setting', {
    p_key: ENABLED_SETTING_KEY,
    p_value: { ...current, [key]: next },
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: next ? 'integrations.enable' : 'integrations.disable',
    entity_type: 'system_setting',
    entity_id: null,
    details: { integration: key },
  })

  revalidatePath('/admin/integrations')
  return { status: 'ok', message: `${def.name} marked as ${next ? 'in use' : 'not available'}.` }
}

/** Makes one real call to the service and records the outcome. */
export async function testIntegrationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const key = String(fd.get('key') ?? '') as IntegrationKey
  const def = integrationDef(key)
  if (!def) return { status: 'error', error: 'Unknown integration.' }

  const result = await probeIntegration(key)
  const current = await readObject(PROBE_SETTING_KEY)
  const svc = createServiceClient()
  await svc.rpc('set_system_setting', {
    p_key: PROBE_SETTING_KEY,
    p_value: { ...current, [key]: { at: new Date().toISOString(), ok: result.ok, detail: result.detail } },
  })

  revalidatePath('/admin/integrations')
  return result.ok ? { status: 'ok', message: result.detail } : { status: 'error', error: result.detail }
}

/** Compares the country profiles against the live GoLogin account. */
export async function checkDriftAction(prev: DriftState): Promise<DriftState> {
  void prev // useActionState passes the previous result; this check ignores it.
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const report = await checkGoLoginDrift()
  await logActivity({
    action: 'integrations.gologin_drift_check',
    entity_type: 'system_setting',
    entity_id: null,
    details: { ok: report.ok, problems: report.rows.filter(r => r.state !== 'ok').length, unmapped: report.unmapped.length },
  })
  return { status: 'ok', report }
}
