'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { runMondaySync } from '@/lib/monday/sync-runner'

export type MondaySyncState =
  | { status: 'ok'; message: string; ms: number; results: Array<{ board: string; items: number; updates: number; ms: number; error?: string }> }
  | { status: 'error'; error: string }
  | null

/**
 * Manually trigger a full Monday → Supabase re-sync of all 4 boards.
 * Same logic as the nightly cron at /api/monday/sync, just gated by
 * a signed-in user instead of CRON_SECRET.
 *
 * Long-running — full sync of all boards takes minutes. The button
 * shows a spinner the whole time.
 */
export async function manualMondaySyncAction(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: MondaySyncState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<MondaySyncState> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const result = await runMondaySync()

  await logActivity({
    action: 'monday.manual_sync',
    entity_type: 'monday',
    details: {
      ms: result.ms,
      ok: result.ok,
      boards: result.results.map(r => ({
        board: r.board,
        items: r.items,
        updates: r.updates,
        ms: r.ms,
        error: r.error ?? null,
      })),
    },
  })

  revalidatePath('/monday', 'layout')

  if (!result.ok) {
    const failed = result.results.find(r => r.error)
    return {
      status: 'error',
      error: failed
        ? `${failed.board} failed: ${failed.error}`
        : 'Sync completed with errors.',
    }
  }

  const totalItems = result.results.reduce((s, r) => s + r.items, 0)
  const totalUpdates = result.results.reduce((s, r) => s + r.updates, 0)
  return {
    status: 'ok',
    ms: result.ms,
    results: result.results.map(r => ({
      board: r.board,
      items: r.items,
      updates: r.updates,
      ms: r.ms,
      ...(r.error ? { error: r.error } : {}),
    })),
    message: `Synced ${totalItems.toLocaleString()} items + ${totalUpdates.toLocaleString()} updates across 4 boards in ${Math.round(result.ms / 1000)}s.`,
  }
}
