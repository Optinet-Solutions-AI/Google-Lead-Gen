'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { runMondaySync } from '@/lib/monday/sync-runner'
import { logActivity } from '@/lib/activity-log'

export type SyncMondayState =
  | { status: 'ok'; message: string; ms: number }
  | { status: 'error'; error: string }
  | null

/**
 * Admin-only server action that triggers an incremental Monday sync
 * across all 4 boards. The S-tag → Monday cross-check reads from the
 * mirror tables the sync populates, so this is the right lever for
 * "make sure my S-tag data reflects Monday RIGHT NOW."
 *
 * Incremental sync only pulls items updated since the newest one
 * already in the mirror + a 1h overlap. In steady state that's a
 * handful of items and the whole thing returns in <30s. Under the
 * hood this is the same code the nightly cron uses.
 */
export async function syncMondayNow(): Promise<SyncMondayState> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: isAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!isAdmin) return { status: 'error', error: 'Admins only.' }

  try {
    const result = await runMondaySync({ full: false })
    await logActivity({
      action: 'monday.sync_now',
      entity_type: 'monday_sync',
      details: {
        triggered_from: '/stag-mapping',
        ms: result.ms,
        ok: result.ok,
        results: result.results,
      },
    })
    revalidatePath('/stag-mapping')
    if (!result.ok) {
      return {
        status: 'error',
        error: `Sync completed with errors after ${(result.ms / 1000).toFixed(1)}s. See activity log for details.`,
      }
    }
    return {
      status: 'ok',
      message: `Synced all boards in ${(result.ms / 1000).toFixed(1)}s.`,
      ms: result.ms,
    }
  } catch (err) {
    console.error('[stag-mapping/syncMondayNow]', err)
    return { status: 'error', error: 'Sync failed. Check the server logs.' }
  }
}
