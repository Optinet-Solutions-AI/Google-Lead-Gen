'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { CronExpressionParser } from 'cron-parser'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type ActionState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

async function requireAuth() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in.')
  return user
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

// ---------------------------------------------------------------------------
// Scheduled set CRUD
// ---------------------------------------------------------------------------

export async function createScheduledSet(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAuth()
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : 'unauthorized' }
  }

  const name = String(formData.get('name') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim() || null
  const cronRaw = String(formData.get('cron') ?? '').trim()
  const cron = cronRaw.length > 0 ? cronRaw : null
  const defaultPages = clampInt(formData.get('default_pages'), 1, 10, 1)
  const isActive = formData.get('is_active') === 'on' || formData.get('is_active') === 'true'

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
      next_run_at: computeNextRun(cron),
    })
    .select('id')
    .single()

  if (error) {
    return {
      status: 'error',
      error: error.code === '23505' ? `A set named "${name}" already exists.` : error.message,
    }
  }

  revalidatePath('/schedules')
  redirect(`/schedules/${data.id}`)
}

export async function updateScheduledSet(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAuth()
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
      next_run_at: computeNextRun(cron),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) return { status: 'error', error: error.message }

  revalidatePath('/schedules')
  revalidatePath(`/schedules/${id}`)
  return { status: 'ok', message: 'Schedule saved.' }
}

export async function deleteScheduledSet(formData: FormData): Promise<void> {
  await requireAuth()
  const id = String(formData.get('id') ?? '').trim()
  if (!id) return
  const svc = createServiceClient()
  await svc.from('scheduled_keyword_sets').delete().eq('id', id)
  revalidatePath('/schedules')
  redirect('/schedules')
}

export async function runScheduledSetNow(formData: FormData): Promise<void> {
  await requireAuth()
  const id = String(formData.get('id') ?? '').trim()
  if (!id) return
  const svc = createServiceClient()
  // Force next_run_at into the past so the next /api/scheduler/tick picks it up
  await svc
    .from('scheduled_keyword_sets')
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', id)
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
    await requireAuth()
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
          : error.message,
    }
  }

  revalidatePath(`/schedules/${setId}`)
  return { status: 'ok', message: `Added "${keyword}" for ${countryCode}.` }
}

export async function toggleScheduledItem(formData: FormData): Promise<void> {
  await requireAuth()
  const itemId = String(formData.get('item_id') ?? '').trim()
  const setId = String(formData.get('set_id') ?? '').trim()
  const isActive = formData.get('is_active') === 'true'
  if (!itemId) return
  const svc = createServiceClient()
  await svc
    .from('scheduled_keyword_items')
    .update({ is_active: !isActive })
    .eq('id', itemId)
  if (setId) revalidatePath(`/schedules/${setId}`)
}

export async function deleteScheduledItem(formData: FormData): Promise<void> {
  await requireAuth()
  const itemId = String(formData.get('item_id') ?? '').trim()
  const setId = String(formData.get('set_id') ?? '').trim()
  if (!itemId) return
  const svc = createServiceClient()
  await svc.from('scheduled_keyword_items').delete().eq('id', itemId)
  if (setId) revalidatePath(`/schedules/${setId}`)
}
