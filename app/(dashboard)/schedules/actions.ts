'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { CronExpressionParser } from 'cron-parser'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/require-admin'

export type ActionState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

// Schedule CRUD + the "run now" / item toggles all write via the
// service-role client (RLS-bypassing) and a stray click could enqueue
// a full scrape or wipe a schedule. Gate on admin. See BUGS.md #1.
async function assertAdmin(): Promise<void> {
  const check = await requireAdmin()
  if (!check.ok) throw new Error(check.error)
}

/** Given a cron expression (or null), compute the first future fire. */
function computeNextRun(cron: string | null): string | null {
  if (!cron) return null
  try {
    const interval = CronExpressionParser.parse(cron, {
      currentDate: new Date(),
      tz: 'UTC',
    })
    return interval.next().toDate().toISOString()
  } catch {
    return null
  }
}

function validCron(cron: string | null): boolean {
  if (!cron) return true
  try {
    CronExpressionParser.parse(cron, { tz: 'UTC' })
    return true
  } catch {
    return false
  }
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

// Log the raw Supabase error server-side, hand the user a generic message.
// Mirrors the helper in leads/actions.ts + scrape/actions.ts (BUGS.md R2-16).
// Keeps schema names, constraint names, and column names out of the
// client-bound action state and Next.js error boundary.
function safeError(err: unknown, fallback: string): string {
  console.error('[schedules/actions]', err)
  return fallback
}

// ---------------------------------------------------------------------------
// Scheduled set CRUD
// ---------------------------------------------------------------------------

export async function createScheduledSet(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertAdmin()
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : 'unauthorized' }
  }

  const name = String(formData.get('name') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim() || null
  const cronRaw = String(formData.get('cron') ?? '').trim()
  const cron = cronRaw.length > 0 ? cronRaw : null
  const defaultPages = clampInt(formData.get('default_pages'), 1, 10, 1)
  const isActive = formData.get('is_active') === 'on' || formData.get('is_active') === 'true'
  const runEnrichment = formData.get('run_enrichment') === 'on' || formData.get('run_enrichment') === 'true'

  if (!name) return { status: 'error', error: 'Name is required.' }
  if (cron && !validCron(cron)) return { status: 'error', error: `Invalid cron: ${cron}` }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from('scheduled_keyword_sets')
    .insert({
      name,
      description,
      cron,
      default_pages: defaultPages,
      is_active: isActive,
      run_enrichment: runEnrichment,
      next_run_at: computeNextRun(cron),
    })
    .select('id')
    .single()

  if (error) {
    return {
      status: 'error',
      error:
        error.code === '23505'
          ? `A set named "${name}" already exists.`
          : safeError(error, 'Failed to create the schedule.'),
    }
  }

  await logActivity({
    action: 'schedule.create',
    entity_type: 'scheduled_set',
    entity_id: data.id,
    details: { name, cron, run_enrichment: runEnrichment },
  })

  revalidatePath('/schedules')
  redirect(`/schedules/${data.id}`)
}

export async function updateScheduledSet(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertAdmin()
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : 'unauthorized' }
  }

  const id = String(formData.get('id') ?? '').trim()
  if (!id) return { status: 'error', error: 'Missing set id.' }

  const name = String(formData.get('name') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim() || null
  const cronRaw = String(formData.get('cron') ?? '').trim()
  const cron = cronRaw.length > 0 ? cronRaw : null
  const defaultPages = clampInt(formData.get('default_pages'), 1, 10, 1)
  const isActive = formData.get('is_active') === 'on' || formData.get('is_active') === 'true'
  const runEnrichment = formData.get('run_enrichment') === 'on' || formData.get('run_enrichment') === 'true'

  if (!name) return { status: 'error', error: 'Name is required.' }
  if (cron && !validCron(cron)) return { status: 'error', error: `Invalid cron: ${cron}` }

  const svc = createServiceClient()
  const { error } = await svc
    .from('scheduled_keyword_sets')
    .update({
      name,
      description,
      cron,
      default_pages: defaultPages,
      is_active: isActive,
      run_enrichment: runEnrichment,
      next_run_at: computeNextRun(cron),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) return { status: 'error', error: safeError(error, 'Failed to save the schedule.') }

  await logActivity({
    action: 'schedule.update',
    entity_type: 'scheduled_set',
    entity_id: id,
    details: { name, cron, is_active: isActive, run_enrichment: runEnrichment },
  })

  revalidatePath('/schedules')
  revalidatePath(`/schedules/${id}`)
  return { status: 'ok', message: 'Schedule saved.' }
}

export async function deleteScheduledSet(formData: FormData): Promise<void> {
  await assertAdmin()
  const id = String(formData.get('id') ?? '').trim()
  if (!id) return
  const svc = createServiceClient()
  const { error } = await svc.from('scheduled_keyword_sets').delete().eq('id', id)
  if (error) throw new Error(safeError(error, 'Failed to delete the schedule.'))
  await logActivity({
    action: 'schedule.delete',
    entity_type: 'scheduled_set',
    entity_id: id,
  })
  revalidatePath('/schedules')
  redirect('/schedules')
}

export async function runScheduledSetNow(formData: FormData): Promise<void> {
  await assertAdmin()
  const id = String(formData.get('id') ?? '').trim()
  if (!id) return
  const svc = createServiceClient()
  // Force next_run_at into the past so the next /api/scheduler/tick picks it up
  const { error } = await svc
    .from('scheduled_keyword_sets')
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', id)
  if (error) throw new Error(safeError(error, 'Failed to run the schedule now.'))
  await logActivity({
    action: 'schedule.run_now',
    entity_type: 'scheduled_set',
    entity_id: id,
  })
  revalidatePath('/schedules')
  revalidatePath(`/schedules/${id}`)
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function addScheduledItem(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertAdmin()
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : 'unauthorized' }
  }

  const setId = String(formData.get('set_id') ?? '').trim()
  const keyword = String(formData.get('keyword') ?? '').trim()
  const countryCode = String(formData.get('country_code') ?? '').trim().toUpperCase()
  const pagesRaw = String(formData.get('pages') ?? '').trim()
  const pages = pagesRaw ? clampInt(pagesRaw, 1, 10, 1) : null
  const priority = clampInt(formData.get('priority'), 0, 100, 0)

  if (!setId) return { status: 'error', error: 'Missing set id.' }
  if (!keyword) return { status: 'error', error: 'Enter a keyword.' }
  if (!countryCode) return { status: 'error', error: 'Pick a country.' }

  const svc = createServiceClient()
  const { error } = await svc.from('scheduled_keyword_items').insert({
    set_id: setId,
    keyword,
    country_code: countryCode,
    pages,
    priority,
    is_active: true,
  })

  if (error) {
    return {
      status: 'error',
      error:
        error.code === '23505'
          ? `"${keyword}" (${countryCode}) is already in this set.`
          : safeError(error, 'Failed to add the keyword.'),
    }
  }

  revalidatePath(`/schedules/${setId}`)
  return { status: 'ok', message: `Added "${keyword}" for ${countryCode}.` }
}

export async function toggleScheduledItem(formData: FormData): Promise<void> {
  await assertAdmin()
  const itemId = String(formData.get('item_id') ?? '').trim()
  const setId = String(formData.get('set_id') ?? '').trim()
  if (!itemId) return
  const svc = createServiceClient()
  // Server-side `NOT is_active` toggle via RPC — avoids the read-
  // modify-write race where two clicks (or a stale tab) both submit
  // the same `is_active` and produce a lost update. See migration
  // 20260515000000_toggle_scheduled_item_atomic.sql.
  const { error } = await svc.rpc('toggle_scheduled_item', { p_item_id: itemId })
  if (error) throw new Error(safeError(error, 'Failed to toggle the scheduled item.'))
  if (setId) revalidatePath(`/schedules/${setId}`)
}

export async function deleteScheduledItem(formData: FormData): Promise<void> {
  await assertAdmin()
  const itemId = String(formData.get('item_id') ?? '').trim()
  const setId = String(formData.get('set_id') ?? '').trim()
  if (!itemId) return
  const svc = createServiceClient()
  const { error } = await svc.from('scheduled_keyword_items').delete().eq('id', itemId)
  if (error) throw new Error(safeError(error, 'Failed to delete the scheduled item.'))
  if (setId) revalidatePath(`/schedules/${setId}`)
}
