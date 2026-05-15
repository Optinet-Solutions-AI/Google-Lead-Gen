import type { NextRequest } from 'next/server'
import { CronExpressionParser } from 'cron-parser'
import { createServiceClient } from '@/lib/supabase/service'
import { requireBearer } from '@/lib/auth/bearer'

// Vercel cron sends GET — alias to the same handler as manual POSTs.
export async function GET(request: NextRequest) {
  return POST(request)
}

/**
 * Called by Vercel cron every minute. See vercel.json.
 *
 * For each scheduled_keyword_sets row where is_active = true AND
 * (next_run_at is null OR next_run_at <= now()):
 *   1. Insert one row into scrape_queue per active item
 *      (keyword, country_code, pages — inherited from set.default_pages
 *      unless the item overrides).
 *   2. Advance next_run_at based on the set's cron expression.
 *   3. Set last_run_at = now().
 *
 * Secured by a shared bearer token. Vercel cron sends
 * `Authorization: Bearer <CRON_SECRET>` if the secret is configured.
 */
export async function POST(request: NextRequest) {
  const check = requireBearer(
    request.headers.get('authorization'),
    process.env.CRON_SECRET,
    { secretName: 'CRON_SECRET' },
  )
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })

  const svc = createServiceClient()
  const now = new Date()

  // Atomically claim due sets. An UPDATE-with-RETURNING uses row-level
  // locks: two concurrent ticks serialize, and the loser sees its WHERE
  // clause fail the EPQ re-check (because last_run_at has just been
  // bumped) — so each due set is enqueued exactly once even if Vercel
  // double-fires the cron or a manual POST overlaps with the schedule.
  // The 30s window is a defensive guard: it rejects re-claims by ticks
  // whose request started before the previous claim finalized.
  const claimWindow = new Date(now.getTime() - 30_000).toISOString()
  const { data: due, error: dueError } = await svc
    .from('scheduled_keyword_sets')
    .update({ last_run_at: now.toISOString() })
    .eq('is_active', true)
    .or(`next_run_at.is.null,next_run_at.lte.${now.toISOString()}`)
    .or(`last_run_at.is.null,last_run_at.lt.${claimWindow}`)
    .select('id, name, cron, default_pages, next_run_at, run_enrichment')
  if (dueError) {
    console.error('[scheduler/tick] claim failed', dueError)
    return Response.json({ error: 'claim failed' }, { status: 500 })
  }

  const runs: Array<{ set: string; enqueued: number; next_run_at: string | null; note?: string }> = []

  for (const set of due ?? []) {
    // Load active items in the set
    const { data: items, error: itemsError } = await svc
      .from('scheduled_keyword_items')
      .select('keyword, country_code, pages, priority')
      .eq('set_id', set.id)
      .eq('is_active', true)
    if (itemsError) {
      runs.push({ set: set.name, enqueued: 0, next_run_at: null, note: itemsError.message })
      continue
    }

    let enqueued = 0
    if (items && items.length > 0) {
      const rows = items.map(i => ({
        keyword: i.keyword,
        country_code: i.country_code,
        pages: i.pages ?? set.default_pages ?? 1,
        priority: i.priority ?? 0,
        scheduled_run_id: set.id,
        with_enrichment: (set as { run_enrichment?: boolean }).run_enrichment ?? false,
      }))
      const { error: insertError } = await svc.from('scrape_queue').insert(rows)
      if (insertError) {
        runs.push({ set: set.name, enqueued: 0, next_run_at: null, note: insertError.message })
        continue
      }
      enqueued = rows.length
    }

    // Compute next_run_at from the cron expression (if set). Anchor
    // from the *previous* scheduled slot when it's in the past — that
    // way a missed firing rolls forward one slot at a time on each
    // subsequent tick (catch-up), instead of jumping straight to the
    // next future slot and silently dropping the intermediate runs.
    let nextRunAtIso: string | null = null
    if (set.cron) {
      try {
        const previousScheduled =
          set.next_run_at ? new Date(set.next_run_at) : null
        const anchor =
          previousScheduled && previousScheduled.getTime() < now.getTime() - 1
            ? previousScheduled
            : new Date(now.getTime() - 1)
        const interval = CronExpressionParser.parse(set.cron, {
          currentDate: anchor,
          tz: 'UTC',
        })
        nextRunAtIso = interval.next().toDate().toISOString()
      } catch (err) {
        runs.push({
          set: set.name,
          enqueued,
          next_run_at: null,
          note: `bad cron: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
    }

    // last_run_at was already stamped during the atomic claim above —
    // this finalize only needs to set the computed next_run_at.
    const { error: updateError } = await svc
      .from('scheduled_keyword_sets')
      .update({
        ...(nextRunAtIso ? { next_run_at: nextRunAtIso } : { next_run_at: null }),
        updated_at: now.toISOString(),
      })
      .eq('id', set.id)

    runs.push({
      set: set.name,
      enqueued,
      next_run_at: nextRunAtIso,
      ...(updateError ? { note: updateError.message } : {}),
    })
  }

  // ----------------------------------------------------------------
  // Orchestrator pass — advance the enrichment chain for any scrape
  // that has with_enrichment=true and isn't yet 'complete'.
  // ----------------------------------------------------------------
  const { data: pending, error: pendingErr } = await svc
    .from('scrape_queue')
    .select('id')
    .eq('with_enrichment', true)
    .eq('status', 'completed')
    .or('enrichment_status.is.null,enrichment_status.in.(pending,affiliate_running,all_running)')
    .order('completed_at', { ascending: true })
    .limit(50)

  const advances: Array<{ id: string; status: string | null; error?: string }> = []
  if (!pendingErr && pending) {
    // Fan out the per-job RPC calls in capped-concurrency batches so a
    // pendng queue of 50 doesn't serialize into ~50 round-trips and
    // blow Vercel's 10s budget. The RPC is independent per job, so any
    // ordering effects are intentional (already deterministic on the
    // DB side).
    const BATCH = 10
    const ids = pending.map(row => (row as { id: string }).id)
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH)
      const results = await Promise.all(
        slice.map(async id => {
          const { data, error } = await svc.rpc('advance_enrichment_chain', { p_job_id: id })
          return { id, data, error }
        }),
      )
      for (const r of results) {
        if (r.error) advances.push({ id: r.id, status: null, error: r.error.message })
        else advances.push({ id: r.id, status: typeof r.data === 'string' ? r.data : null })
      }
    }
  }

  return Response.json({
    ok: true,
    now: now.toISOString(),
    runs,
    enrichment_advances: advances,
  })
}
