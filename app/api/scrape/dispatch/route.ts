import type { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireBearer } from '@/lib/auth/bearer'
import { runApifyJob, type ScrapeJob } from '@/lib/scrape/apify-runner'

export const dynamic = 'force-dynamic'
// An Apify run polls for up to ~200s, so one job can occupy most of this.
export const maxDuration = 300

/**
 * Runs the pending Apify scrapes. Called by Vercel cron every minute.
 *
 * This replaces the VM worker's poll loop. worker.py used to claim these and
 * call the Apify API itself, so when the AWS account was suspended on
 * 14 October every scrape stopped — Apify ones included, because the VMs were
 * its dispatcher rather than its alternative.
 *
 * Claiming is a guarded UPDATE rather than the claim_scrape_job RPC: that one
 * takes a per-country GoLogin profile lock, which exists to stop two browsers
 * sharing a profile and has no meaning here, and it cannot be scoped to one
 * source, so it would hand back VM jobs nothing can run. `status = pending` in
 * the WHERE clause is the lock — two overlapping invocations cannot both win
 * the same row.
 */
export async function GET(request: NextRequest) {
  return POST(request)
}

export async function POST(request: NextRequest) {
  const check = requireBearer(request.headers.get('authorization'), process.env.CRON_SECRET, { secretName: 'CRON_SECRET' })
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })

  const svc = createServiceClient()
  const workerId = `vercel-${crypto.randomUUID().slice(0, 8)}`

  // Cron fires every minute and a run can take ~3 minutes, so invocations
  // overlap. Keep the batch small: the guarded claim means an overlap is
  // harmless, and a long queue simply drains over successive ticks.
  const MAX_PER_TICK = 2

  const { data: candidates, error } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, search_engine, pages, attempts')
    .eq('scrape_source', 'apify')
    .eq('status', 'pending')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(MAX_PER_TICK * 4)
  if (error) {
    console.error('[dispatch] could not list pending jobs', error.message)
    return Response.json({ error: 'Could not list pending jobs.' }, { status: 500 })
  }

  const ran: Array<Record<string, unknown>> = []

  for (const row of (candidates ?? []) as ScrapeJob[]) {
    if (ran.length >= MAX_PER_TICK) break

    // Win the row or move on. `.eq('status','pending')` makes this atomic:
    // whichever invocation updates first is the only one that gets rows back.
    const { data: claimed } = await svc
      .from('scrape_queue')
      .update({
        status: 'running',
        claimed_by: workerId,
        started_at: new Date().toISOString(),
        attempts: (row.attempts ?? 0) + 1,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
    if (!claimed || claimed.length === 0) continue

    try {
      const outcome = await runApifyJob(row)
      if (outcome.status === 'completed') {
        ran.push({ job: row.id, keyword: row.keyword, ...outcome })
      } else {
        // Back to pending so the next tick retries, unless it has already had
        // several goes — then park it as failed with the reason on the row,
        // which is what the batch view shows the operator.
        const attempts = (row.attempts ?? 0) + 1
        const giveUp = attempts >= 3
        await svc
          .from('scrape_queue')
          .update({
            status: giveUp ? 'failed' : 'pending',
            claimed_by: null,
            error_message: outcome.reason,
            ...(giveUp ? { completed_at: new Date().toISOString() } : {}),
          })
          .eq('id', row.id)
        ran.push({ job: row.id, keyword: row.keyword, status: giveUp ? 'failed' : 'requeued', reason: outcome.reason })
      }
    } catch (e) {
      // Never leave a row stuck in `running` — that is invisible to the
      // operator and nothing would ever pick it up again.
      const message = e instanceof Error ? e.message : String(e)
      console.error('[dispatch] job threw', row.id, message)
      await svc
        .from('scrape_queue')
        .update({ status: 'pending', claimed_by: null, error_message: 'Scrape failed unexpectedly — retrying.' })
        .eq('id', row.id)
      ran.push({ job: row.id, status: 'error', message })
    }
  }

  return Response.json({ ok: true, worker: workerId, ran })
}
