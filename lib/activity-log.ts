import 'server-only'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Append-only audit trail. Call from any server action that mutates
 * data so the dashboard can show a history of who did what.
 *
 * Failures are swallowed — logging must never break the underlying
 * action. Always reads the user from the cookie-scoped supabase
 * client; writes go through the service role client (RLS-bypassing).
 */
export async function logActivity(input: {
  action: string
  entity_type?: string | null
  entity_id?: string | number | null
  details?: Record<string, unknown> | null
}): Promise<void> {
  try {
    const auth = await createServerClient()
    const {
      data: { user },
    } = await auth.auth.getUser()

    const svc = createServiceClient()
    await svc.from('activity_log').insert({
      user_id: user?.id ?? null,
      user_email: user?.email ?? null,
      action: input.action,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id != null ? String(input.entity_id) : null,
      details: input.details ?? null,
    })
  } catch (err) {
    console.error('[activity-log] insert failed:', err instanceof Error ? err.message : err)
  }
}
