import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { sleep } from '@/lib/monday/graphql'
import { pushLeadToMonday } from '@/lib/monday/push-lead'
import {
  gatherEntityCandidates,
  pushEntityToMonday,
  type EntityCandidate,
} from '@/lib/monday/push-entity'
import { isSocialEngine, type SocialEngine } from '@/lib/monday/engine-config'

/**
 * Job-level "Push to Monday": send every worth-pushing result of a single
 * scrape job onto the Rooster Leads board in one click.
 *
 * Two paths, picked off the job's `search_engine`:
 *   - Google / Bing (and any null engine) → the existing per-lead push over
 *     google_lead_gen_table (lib/monday/push-lead.ts). Candidates: leads
 *     that carry an s-tag (an affiliate signal), aren't marked not-relevant,
 *     and haven't been pushed yet.
 *   - The 8 social engines → the generic per-entity push (push-entity.ts).
 *     Candidates: likely-affiliate entities not gated out / not pushed.
 *
 * The candidate predicate is intentionally conservative (only flagged
 * affiliates) so a one-click job push doesn't flood the board with the
 * long tail of non-affiliate results. Operators can still push anything
 * else by hand from the leads drawer.
 */

export type JobPushKind = 'leads' | 'entities'

export type JobPushCandidate = {
  /** Stable id for the underlying row — number for google leads, uuid string
   *  for social entities. */
  id: string
  label: string
  alreadyPushed: boolean
}

export type JobPushPlan = {
  jobId: string
  engine: string | null
  kind: JobPushKind
  jobKeyword: string
  jobCountry: string
  /** Candidates worth pushing (already-pushed ones included, flagged, so the
   *  UI/dry-run can show "5 new, 2 already on Monday"). */
  candidates: JobPushCandidate[]
}

export type JobPushSummary = {
  ok: true
  engine: string | null
  kind: JobPushKind
  /** Eligible candidates that weren't already pushed (what we attempted). */
  attempted: number
  pushed: number
  skippedAlreadyPushed: number
  failed: number
  /** Up to a few human-readable failure lines for surfacing in the UI. */
  errors: string[]
}
export type JobPushError = { ok: false; error: string }

type JobRow = {
  id: string
  keyword: string | null
  country_code: string | null
  search_engine: string | null
}

async function loadJob(jobId: string): Promise<JobRow | null> {
  const svc = createServiceClient()
  const { data } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, search_engine')
    .eq('id', jobId)
    .maybeSingle()
  return (data as JobRow | null) ?? null
}

/** Last-resort item label for a google lead. */
function leadLabel(row: { domain: string | null; url: string | null; id: number }): string {
  return row.domain || row.url || `lead-${row.id}`
}

/**
 * Read-only: figure out what a job push WOULD do, without writing anything.
 * Powers both the dry-run script and the confirmation summary.
 */
export async function planJobPush(jobId: string): Promise<JobPushPlan | JobPushError> {
  const job = await loadJob(jobId)
  if (!job) return { ok: false, error: 'Job not found.' }

  const engine = job.search_engine
  const jobKeyword = job.keyword ?? ''
  const jobCountry = job.country_code ?? ''

  if (isSocialEngine(engine)) {
    const cands = await gatherEntityCandidates(engine, jobId)
    return {
      jobId,
      engine,
      kind: 'entities',
      jobKeyword,
      jobCountry,
      candidates: cands.map((c: EntityCandidate) => ({
        id: c.id,
        label: c.label,
        alreadyPushed: c.alreadyPushed,
      })),
    }
  }

  // Google / Bing / null → leads path.
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select('id, domain, url, pushed_to_monday_at')
    .eq('scrape_job_id', jobId)
    .eq('has_s_tags', true)
    .eq('is_not_relevant', false)
  if (error) return { ok: false, error: error.message }
  const rows = (data ?? []) as unknown as Array<{
    id: number
    domain: string | null
    url: string | null
    pushed_to_monday_at: string | null
  }>
  return {
    jobId,
    engine,
    kind: 'leads',
    jobKeyword,
    jobCountry,
    candidates: rows.map(r => ({
      id: String(r.id),
      label: leadLabel(r),
      alreadyPushed: r.pushed_to_monday_at != null,
    })),
  }
}

/** Small gap between pushes so a job with dozens of candidates doesn't
 *  hammer Monday's rate limiter (the GQL client also retries 429s). */
const PUSH_GAP_MS = 350

/**
 * Live job push. Resolves the plan, then pushes each not-already-pushed
 * candidate, stamping as it goes. Returns a per-job summary.
 */
export async function pushJobToMonday(
  jobId: string,
  opts: { pushedBy: string; ownerId: number; note?: string },
): Promise<JobPushSummary | JobPushError> {
  const plan = await planJobPush(jobId)
  if ('ok' in plan && plan.ok === false) return plan
  const p = plan as JobPushPlan

  const toPush = p.candidates.filter(c => !c.alreadyPushed)
  const skippedAlreadyPushed = p.candidates.length - toPush.length

  let pushed = 0
  let failed = 0
  const errors: string[] = []

  const noteOpt = opts.note !== undefined ? { note: opts.note } : {}
  for (let i = 0; i < toPush.length; i++) {
    const cand = toPush[i]
    if (!cand) continue
    if (i > 0) await sleep(PUSH_GAP_MS)
    try {
      const res =
        p.kind === 'leads'
          ? await pushLeadToMonday(Number(cand.id), {
              pushedBy: opts.pushedBy,
              pushedByMondayId: opts.ownerId,
              ...noteOpt,
            })
          : await pushEntityToMonday(p.engine as SocialEngine, cand.id, {
              jobKeyword: p.jobKeyword,
              jobCountry: p.jobCountry,
              pushedBy: opts.pushedBy,
              ownerId: opts.ownerId,
              ...noteOpt,
            })
      if (res.ok) {
        pushed++
      } else {
        failed++
        if (errors.length < 5) errors.push(`${cand.label}: ${res.error}`)
      }
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      if (errors.length < 5) errors.push(`${cand.label}: ${msg}`)
    }
  }

  return {
    ok: true,
    engine: p.engine,
    kind: p.kind,
    attempted: toPush.length,
    pushed,
    skippedAlreadyPushed,
    failed,
    errors,
  }
}
