import type { NextRequest } from 'next/server'
import { CronExpressionParser } from 'cron-parser'
import { createServiceClient } from '@/lib/supabase/service'

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
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization') ?? ''
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const svc = createServiceClient()
  const now = new Date()

  // Find sets that are due
  const { data: due, error: dueError } = await svc
    .from('scheduled_keyword_sets')
    .select('id, name, cron, default_pages, next_run_at, run_enrichment')
    .eq('is_active', true)
    .or(`next_run_at.is.null,next_run_at.lte.${now.toISOString()}`)
    .limit(50)
  if (dueError) return Response.json({ error: dueError.message }, { status: 500 })

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

    // Compute next_run_at from the cron expression (if set)
    let nextRunAtIso: string | null = null
    if (set.cron) {
      try {
        const interval = CronExpressionParser.parse(set.cron, {
          currentDate: now,
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

    const { error: updateError } = await svc
      .from('scheduled_keyword_sets')
      .update({
        last_run_at: now.toISOString(),
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
    for (const row of pending) {
      const id = (row as { id: string }).id
      const { data, error } = await svc.rpc('advance_enrichment_chain', { p_job_id: id })
      if (error) {
        advances.push({ id, status: null, error: error.message })
      } else {
        advances.push({ id, status: typeof data === 'string' ? data : null })
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
