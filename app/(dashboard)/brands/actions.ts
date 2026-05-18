'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/require-admin'

// All brand mutations write via the service-role client (bypasses RLS),
// so the action MUST gate on admin or any signed-in user could flip
// brands on/off, rename, or delete them. See BUGS.md #1.
async function assertAdmin(): Promise<void> {
  const check = await requireAdmin()
  if (!check.ok) throw new Error(check.error)
}

function normaliseDomain(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
}

export type AddBrandState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export async function addRoosterBrand(
  _prev: AddBrandState,
  formData: FormData,
): Promise<AddBrandState> {
  await assertAdmin()
  const domain = normaliseDomain(formData.get('domain'))
  const brand_name = String(formData.get('brand_name') ?? '').trim() || null
  if (!domain) return { status: 'error', error: 'Domain required.' }

  const svc = createServiceClient()
  const { error } = await svc
    .from('rooster_brands')
    .insert({ domain, brand_name })
  if (error) {
    if (error.code === '23505') {
      return { status: 'error', error: `Domain "${domain}" already exists.` }
    }
    return { status: 'error', error: error.message }
  }

  await logActivity({
    action: 'brand.add',
    entity_type: 'rooster_brand',
    entity_id: domain,
    details: { domain, brand_name },
  })

  revalidatePath('/brands')
  revalidatePath('/scrape', 'layout')
  return { status: 'ok', message: `Added ${domain}` }
}

export async function setRoosterBrandActive(formData: FormData): Promise<void> {
  await assertAdmin()
  const id = Number(formData.get('id'))
  const value = formData.get('value') === 'true'
  if (!Number.isFinite(id)) throw new Error('Missing id.')

  const svc = createServiceClient()
  const { error } = await svc
    .from('rooster_brands')
    .update({ is_active: value, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'brand.toggle_active',
    entity_type: 'rooster_brand',
    entity_id: id,
    details: { is_active: value },
  })

  revalidatePath('/brands')
  revalidatePath('/scrape', 'layout')
}

export async function updateRoosterBrandName(formData: FormData): Promise<void> {
  await assertAdmin()
  const id = Number(formData.get('id'))
  const brand_name = String(formData.get('brand_name') ?? '').trim() || null
  if (!Number.isFinite(id)) throw new Error('Missing id.')

  const svc = createServiceClient()
  const { error } = await svc
    .from('rooster_brands')
    .update({ brand_name, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'brand.update',
    entity_type: 'rooster_brand',
    entity_id: id,
    details: { field: 'brand_name', brand_name },
  })

  revalidatePath('/brands')
}

export async function updateRoosterBrandNotes(formData: FormData): Promise<void> {
  await assertAdmin()
  const id = Number(formData.get('id'))
  const notes = String(formData.get('notes') ?? '').trim() || null
  if (!Number.isFinite(id)) throw new Error('Missing id.')

  const svc = createServiceClient()
  const { error } = await svc
    .from('rooster_brands')
    .update({ notes, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'brand.update',
    entity_type: 'rooster_brand',
    entity_id: id,
    details: { field: 'notes', has_notes: !!notes },
  })

  revalidatePath('/brands')
}

export async function deleteRoosterBrand(formData: FormData): Promise<void> {
  await assertAdmin()
  const id = Number(formData.get('id'))
  if (!Number.isFinite(id)) throw new Error('Missing id.')

  const svc = createServiceClient()
  const { error } = await svc.from('rooster_brands').delete().eq('id', id)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'brand.delete',
    entity_type: 'rooster_brand',
    entity_id: id,
  })

  revalidatePath('/brands')
  revalidatePath('/scrape', 'layout')
}
