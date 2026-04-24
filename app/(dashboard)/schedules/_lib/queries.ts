import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

export type ScheduledSet = {
  id: string
  name: string
  description: string | null
  cron: string | null
  is_active: boolean
  default_pages: number
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
  item_count: number
}

export type ScheduledItem = {
  id: string
  set_id: string
  keyword: string
  country_code: string
  pages: number | null
  priority: number
  is_active: boolean
  created_at: string
}

export async function listScheduledSets(): Promise<ScheduledSet[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('scheduled_keyword_sets')
    .select(
      'id, name, description, cron, is_active, default_pages, last_run_at, next_run_at, created_at, updated_at',
    )
    .order('created_at', { ascending: false })
  if (error) throw error

  // Fetch item counts in a second call (keeps the main query simple)
  const sets = (data ?? []) as Omit<ScheduledSet, 'item_count'>[]
  if (sets.length === 0) return []

  const ids = sets.map(s => s.id)
  const { data: items, error: itemsError } = await svc
    .from('scheduled_keyword_items')
    .select('set_id')
    .in('set_id', ids)
  if (itemsError) throw itemsError

  const counts = new Map<string, number>()
  for (const it of items ?? []) {
    const k = it.set_id as string
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }

  return sets.map(s => ({ ...s, item_count: counts.get(s.id) ?? 0 }))
}

export async function getScheduledSet(id: string): Promise<{
  set: ScheduledSet | null
  items: ScheduledItem[]
}> {
  const svc = createServiceClient()

  const [setRes, itemsRes] = await Promise.all([
    svc
      .from('scheduled_keyword_sets')
      .select(
        'id, name, description, cron, is_active, default_pages, last_run_at, next_run_at, created_at, updated_at',
      )
      .eq('id', id)
      .maybeSingle(),
    svc
      .from('scheduled_keyword_items')
      .select('id, set_id, keyword, country_code, pages, priority, is_active, created_at')
      .eq('set_id', id)
      .order('created_at', { ascending: true }),
  ])

  if (setRes.error) throw setRes.error
  if (itemsRes.error) throw itemsRes.error

  const items = (itemsRes.data ?? []) as ScheduledItem[]
  if (!setRes.data) return { set: null, items }

  return {
    set: { ...(setRes.data as Omit<ScheduledSet, 'item_count'>), item_count: items.length },
    items,
  }
}

export async function listActiveCountries(): Promise<Array<{ code: string; name: string }>> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('gologin_profiles')
    .select('country_code, country_name')
    .eq('is_active', true)
    .not('gologin_profile_id', 'is', null)
    .order('country_name', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => ({ code: r.country_code, name: r.country_name }))
}
