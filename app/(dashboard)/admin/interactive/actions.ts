'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { buildSignedVncUrl } from '@/lib/interactive/signed-vnc-url'
import { logActivity } from '@/lib/activity-log'

export type CheckpointMutationState =
  | { status: 'ok' }
  | { status: 'error'; error: string }
  | null

/**
 * Any signed-in user can resolve / cancel / re-queue a checkpoint.
 * Captcha resolution is a routine ops task — bottlenecking it on a
 * single admin defeats the point of the Captcha solver flow when the
 * team is more than one person. The DB layer still enforces admin-only
 * for re-queue via defense-in-depth (see migration 20260519050000), but
 * server actions here call via service-role so that gate passes through.
 */
async function requireSignedIn(): Promise<
  | { ok: true; user_id: string; display: string | null }
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
  return { ok: true, user_id: user.id, display }
}

export async function resolveCheckpointAction(
  _prev: CheckpointMutationState,
  fd: FormData,
): Promise<CheckpointMutationState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isInteger(id) || id <= 0) return { status: 'error', error: 'Missing checkpoint id.' }

  const note = String(fd.get('note') ?? '').trim() || null

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('resolve_interactive_checkpoint', {
    p_id: id,
    p_user_id: auth.user_id,
    p_note: note,
    p_user: auth.display,
  })
  if (error) return { status: 'error', error: error.message }
  const conflict = pickClaimConflict(data)
  if (conflict) return { status: 'error', error: conflict }

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

export async function requeueCheckpointAction(
  _prev: CheckpointMutationState,
  fd: FormData,
): Promise<CheckpointMutationState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const jobId = String(fd.get('job_id') ?? '').trim()
  if (!jobId) return { status: 'error', error: 'Missing job id.' }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('requeue_scrape_after_captcha_solver', {
    p_job_id: jobId,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'interactive.requeue',
    entity_type: 'scrape_job',
    entity_id: jobId,
    details: { prior_status: data ?? null },
  })

  revalidatePath('/admin/interactive')
  revalidatePath('/scrape', 'layout')
  return { status: 'ok' }
}

// ============================================================
// Soft claim — Open VNC + release
// ============================================================
//
// "Open VNC" no longer just hands the operator a signed URL — it first
// atomically takes the claim via claim_interactive_checkpoint(). On
// success the action returns the signed URL and the client opens it
// in the blank tab that was pre-allocated during the click event
// (popup-blockers stay happy because the open happens inside the user
// gesture). On conflict the client closes the blank tab and shows
// "Solving by X — Ym left" instead.

export type OpenVncResult =
  | {
      ok: true
      vnc_url: string
      claim_expires_at: string
      claimed_by_display: string | null
    }
  | {
      ok: false
      reason: 'claimed_by_other' | 'not_waiting' | 'not_found' | 'no_vnc_config' | 'forbidden' | 'unknown'
      error?: string
      claimed_by_display?: string | null
      claim_expires_at?: string
    }

export async function openVncAction(
  checkpointId: number,
  workerPort: number,
): Promise<OpenVncResult> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { ok: false, reason: 'forbidden', error: auth.error }
  if (!Number.isInteger(checkpointId) || checkpointId <= 0) {
    return { ok: false, reason: 'unknown', error: 'Missing checkpoint id.' }
  }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('claim_interactive_checkpoint', {
    p_id: checkpointId,
    p_user_id: auth.user_id,
    p_display: auth.display,
  })
  if (error) return { ok: false, reason: 'unknown', error: error.message }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        ok: boolean
        reason: string | null
        claimed_by_uid: string | null
        claimed_by_display: string | null
        claim_expires_at: string | null
      }
    | null
  if (!row) return { ok: false, reason: 'unknown', error: 'No response from claim RPC.' }

  if (!row.ok) {
    const reasonNarrowed = (
      [
        'claimed_by_other',
        'not_waiting',
        'not_found',
        'no_vnc_config',
        'forbidden',
        'unknown',
      ] as const
    ).includes(row.reason as never)
      ? (row.reason as 'claimed_by_other' | 'not_waiting' | 'not_found' | 'no_vnc_config' | 'forbidden' | 'unknown')
      : 'unknown'
    const result: OpenVncResult = {
      ok: false,
      reason: reasonNarrowed,
      claimed_by_display: row.claimed_by_display,
    }
    if (row.claim_expires_at) result.claim_expires_at = row.claim_expires_at
    return result
  }

  // Pull the per-checkpoint VM host so multi-VM fleets route to the
  // right ingress. NULL is fine — buildSignedVncUrl falls back to
  // NEXT_PUBLIC_VNC_BASE_URL when this is unset (single-VM dev).
  const { data: hostRow } = await svc
    .from('interactive_checkpoints')
    .select('vnc_host')
    .eq('id', checkpointId)
    .maybeSingle<{ vnc_host: string | null }>()

  const vnc_url = await buildSignedVncUrl({
    workerPort,
    hostBase: hostRow?.vnc_host ?? null,
  })
  if (!vnc_url) {
    return {
      ok: false,
      reason: 'no_vnc_config',
      error: 'NEXT_PUBLIC_VNC_BASE_URL or INTERACTIVE_VNC_HMAC_SECRET is missing on the server.',
    }
  }

  await logActivity({
    action: 'interactive.claim',
    entity_type: 'interactive_checkpoint',
    entity_id: checkpointId,
    details: { claim_expires_at: row.claim_expires_at },
  })

  revalidatePath('/admin/interactive')
  return {
    ok: true,
    vnc_url,
    claim_expires_at: row.claim_expires_at ?? new Date(Date.now() + 8 * 60_000).toISOString(),
    claimed_by_display: row.claimed_by_display,
  }
}

export async function releaseCheckpointClaimAction(
  checkpointId: number,
): Promise<{ ok: boolean }> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { ok: false }
  if (!Number.isInteger(checkpointId) || checkpointId <= 0) return { ok: false }

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('release_interactive_checkpoint', {
    p_id: checkpointId,
    p_user_id: auth.user_id,
  })
  if (error) return { ok: false }
  revalidatePath('/admin/interactive')
  return { ok: data === true }
}

export async function cancelCheckpointAction(
  _prev: CheckpointMutationState,
  fd: FormData,
): Promise<CheckpointMutationState> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isInteger(id) || id <= 0) return { status: 'error', error: 'Missing checkpoint id.' }

  const note = String(fd.get('note') ?? '').trim() || null

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('cancel_interactive_checkpoint', {
    p_id: id,
    p_user_id: auth.user_id,
    p_note: note,
    p_user: auth.display,
  })
  if (error) return { status: 'error', error: error.message }
  const conflict = pickClaimConflict(data)
  if (conflict) return { status: 'error', error: conflict }

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

/**
 * resolve / cancel RPCs now return a structured row: ok=false +
 * reason='claimed_by_other' means another user holds the live VNC
 * claim. Translate that into a friendly inline error; everything else
 * (not_waiting, not_found) we surface verbatim — it generally means
 * the row already moved on between the user's last refresh and the
 * click, and Next will revalidate so the card disappears anyway.
 */
function pickClaimConflict(data: unknown): string | null {
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') return null
  const r = row as { ok?: boolean; reason?: string | null; claimed_by_display?: string | null }
  if (r.ok !== false) return null
  if (r.reason === 'claimed_by_other') {
    return `Locked — ${r.claimed_by_display ?? 'another user'} is currently solving this captcha. Wait for their claim to expire (up to 8 min) and try again.`
  }
  if (r.reason === 'not_waiting') {
    return 'This checkpoint was already resolved or cancelled by someone else — refreshing.'
  }
  if (r.reason === 'not_found') {
    return 'Checkpoint not found.'
  }
  return null
}
