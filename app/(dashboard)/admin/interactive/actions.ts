'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

export type CheckpointMutationState =
  | { status: 'ok' }
  | { status: 'error'; error: string }
  | null

async function requireAdmin(): Promise<
  | { ok: true; user_id: string; display: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: adminFlag, error: adminErr } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (adminErr) return { ok: false, error: adminErr.message }
  if (!adminFlag) return { ok: false, error: 'Admin access required.' }

  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('username, display_name')
    .eq('id', user.id)
    .maybeSingle()
  const profile = profileRow as { username: string | null; display_name: string | null } | null
  const display = profile?.display_name ?? profile?.username ?? user.email ?? null
  return { ok: true, user_id: user.id, display }
}

export async function resolveCheckpointAction(
  _prev: CheckpointMutationState,
  fd: FormData,
): Promise<CheckpointMutationState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isFinite(id)) return { status: 'error', error: 'Missing checkpoint id.' }

  const note = String(fd.get('note') ?? '').trim() || null

  const svc = createServiceClient()
  const { error } = await svc.rpc('resolve_interactive_checkpoint', {
    p_id: id,
    p_note: note,
    p_user: auth.display,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'interactive.resolve',
    entity_type: 'interactive_checkpoint',
    entity_id: id,
    details: { note },
  })

  revalidatePath('/admin/interactive')
  revalidatePath('/scrape', 'layout')
  return { status: 'ok' }
}

export async function cancelCheckpointAction(
  _prev: CheckpointMutationState,
  fd: FormData,
): Promise<CheckpointMutationState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isFinite(id)) return { status: 'error', error: 'Missing checkpoint id.' }

  const note = String(fd.get('note') ?? '').trim() || null

  const svc = createServiceClient()
  const { error } = await svc.rpc('cancel_interactive_checkpoint', {
    p_id: id,
    p_note: note,
    p_user: auth.display,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'interactive.cancel',
    entity_type: 'interactive_checkpoint',
    entity_id: id,
    details: { note },
  })

  revalidatePath('/admin/interactive')
  revalidatePath('/scrape', 'layout')
  return { status: 'ok' }
}
