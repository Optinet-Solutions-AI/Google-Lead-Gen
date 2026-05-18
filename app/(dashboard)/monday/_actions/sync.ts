'use server'

import { revalidatePath } from 'next/cache'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/require-admin'
import { runMondaySync } from '@/lib/monday/sync-runner'

export type MondaySyncState =
  | { status: 'ok'; message: string; ms: number; results: Array<{ board: string; items: number; updates: number; ms: number; error?: string }> }
  | { status: 'error'; error: string }
  | null

/**
 * Manually trigger a full Monday → Supabase re-sync of all 4 boards.
 * Same logic as the nightly cron at /api/monday/sync, just gated by
 * admin caller instead of CRON_SECRET (BUGS.md #1 — previously any
 * signed-in user could fire this off and consume the full Monday API
 * budget for minutes).
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
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

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
