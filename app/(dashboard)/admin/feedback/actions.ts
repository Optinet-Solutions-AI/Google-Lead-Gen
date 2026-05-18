'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

export type SubmitFeedbackState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export type FeedbackMutationState =
  | { status: 'ok' }
  | { status: 'error'; error: string }
  | null

const VALID_STATUSES = new Set(['open', 'in_progress', 'resolved', 'rejected'])

async function requireSignedIn(): Promise<
  | { ok: true; user_id: string; user_email: string | null; display: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('username, display_name')
    .eq('id', user.id)
    .maybeSingle()
  const profile = profileRow as { username: string | null; display_name: string | null } | null
  const display = profile?.display_name ?? profile?.username ?? user.email ?? null
  return { ok: true, user_id: user.id, user_email: user.email ?? null, display }
}

async function requireAdmin(): Promise<
  | { ok: true; user_id: string; display: string | null }
  | { ok: false; error: string }
> {
  const auth = await requireSignedIn()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.rpc('is_admin', { p_user_id: auth.user_id })
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Admin access required.' }
  return { ok: true, user_id: auth.user_id, display: auth.display }
}

/**
 * Any signed-in user can submit feedback from the floating widget.
 * URL is optional; message is required (1-4000 chars).
 */
export async function submitFeedbackAction(
  _prev: SubmitFeedbackState,
  fd: FormData,
): Promise<SubmitFeedbackState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const url = String(fd.get('url') ?? '').trim() || null
  const message = String(fd.get('message') ?? '').trim()

  if (!message) return { status: 'error', error: 'Message is required.' }
  if (message.length > 4000) {
    return { status: 'error', error: `Message too long (${message.length}/4000).` }
  }
  if (url && url.length > 2000) {
    return { status: 'error', error: 'URL too long.' }
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return {
      status: 'error',
      error: "URL should start with http:// or https:// (or leave it blank).",
    }
  }

  const svc = createServiceClient()
  const { error } = await svc.from('qa_feedback').insert({
    user_id: auth.user_id,
    user_display: auth.display,
    user_email: auth.user_email,
    url,
    message,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'qa_feedback.submit',
    entity_type: 'qa_feedback',
    entity_id: null,
    details: { has_url: url !== null, message_len: message.length },
  })

  revalidatePath('/admin/feedback')
  return { status: 'ok', message: 'Thanks! The team has been notified.' }
}

export async function setFeedbackStatusAction(
  _prev: FeedbackMutationState,
  fd: FormData,
): Promise<FeedbackMutationState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isInteger(id) || id <= 0) return { status: 'error', error: 'Missing feedback id.' }

  const next = String(fd.get('status') ?? '').trim()
  if (!VALID_STATUSES.has(next)) {
    return { status: 'error', error: `Invalid status "${next}".` }
  }

  const svc = createServiceClient()
  const patch: Record<string, unknown> = { status: next }
  if (next === 'resolved' || next === 'rejected') {
    patch.resolved_at = new Date().toISOString()
    patch.resolved_by = auth.display
  }
  const { error } = await svc.from('qa_feedback').update(patch).eq('id', id)
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'qa_feedback.set_status',
    entity_type: 'qa_feedback',
    entity_id: id,
    details: { new_status: next },
  })

  revalidatePath('/admin/feedback')
  return { status: 'ok' }
}

export async function deleteFeedbackAction(
  _prev: FeedbackMutationState,
  fd: FormData,
): Promise<FeedbackMutationState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isInteger(id) || id <= 0) return { status: 'error', error: 'Missing feedback id.' }

  const svc = createServiceClient()
  const { error } = await svc.from('qa_feedback').delete().eq('id', id)
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'qa_feedback.delete',
    entity_type: 'qa_feedback',
    entity_id: id,
    details: {},
  })

  revalidatePath('/admin/feedback')
  return { status: 'ok' }
}
