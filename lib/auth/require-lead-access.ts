import 'server-only'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type LeadAccessCheck =
  | { ok: true; user_id: string; email: string | null; is_admin: boolean }
  | { ok: false; error: string }

/**
 * Verify the caller may mutate a single lead.
 *
 * Allowed when:
 *   - the lead's owning scrape job has `created_by_email` matching the
 *     signed-in user's email (case-insensitive), OR
 *   - the user is an admin (`is_admin` RPC).
 *
 * Use from server actions in `app/(dashboard)/leads/actions.ts` that
 * mutate via the service-role client — those bypass RLS, so without
 * this check any signed-in user could flip labels, push leads to
 * Monday, or delete rows on jobs they don't own. See BUGS.md R3-S2.
 */
export async function requireLeadAccess(leadId: number): Promise<LeadAccessCheck> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  if (!Number.isInteger(leadId) || leadId <= 0) {
    return { ok: false, error: 'Missing lead id.' }
  }

  const svc = createServiceClient()
  const { data: lead, error: leadErr } = await svc
    .from('google_lead_gen_table')
    .select('scrape_job_id')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) {
    console.error('[requireLeadAccess] lead lookup', leadErr)
    return { ok: false, error: 'Failed to look up lead.' }
  }
  if (!lead) return { ok: false, error: 'Lead not found.' }

  const jobId = (lead as { scrape_job_id: string | null }).scrape_job_id
  if (!jobId) return { ok: false, error: 'Lead has no owning job.' }

  return await checkJobOwnership(svc, jobId, user.id, user.email ?? null)
}

/**
 * Bulk variant — checks every lead in one go. Returns ok only when ALL
 * leads route to a job the caller owns (or the caller is admin).
 *
 * The job-ownership check runs once per unique scrape_job_id, so a 200-
 * lead batch that all comes from the same scrape job costs one lookup,
 * not 200.
 */
export async function requireLeadsAccess(leadIds: number[]): Promise<LeadAccessCheck> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const ids = leadIds.filter(n => Number.isInteger(n) && n > 0)
  if (ids.length === 0) return { ok: false, error: 'No lead ids.' }

  const svc = createServiceClient()

  // Admin short-circuit — avoids the per-job ownership loop entirely.
  const { data: isAdmin, error: adminErr } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (adminErr) {
    console.error('[requireLeadsAccess] is_admin', adminErr)
    return { ok: false, error: 'Failed to verify admin access.' }
  }
  if (isAdmin) {
    return { ok: true, user_id: user.id, email: user.email ?? null, is_admin: true }
  }

  if (!user.email) return { ok: false, error: 'Account has no email.' }

  const { data: leads, error: leadsErr } = await svc
    .from('google_lead_gen_table')
    .select('scrape_job_id')
    .in('id', ids)
  if (leadsErr) {
    console.error('[requireLeadsAccess] leads lookup', leadsErr)
    return { ok: false, error: 'Failed to look up leads.' }
  }

  const jobIds = new Set<string>()
  for (const row of (leads ?? []) as Array<{ scrape_job_id: string | null }>) {
    if (!row.scrape_job_id) {
      return { ok: false, error: 'A selected lead has no owning job.' }
    }
    jobIds.add(row.scrape_job_id)
  }
  if (jobIds.size === 0) return { ok: false, error: 'Lead lookup returned no rows.' }

  const { data: jobs, error: jobsErr } = await svc
    .from('scrape_queue')
    .select('id, created_by_email')
    .in('id', Array.from(jobIds))
  if (jobsErr) {
    console.error('[requireLeadsAccess] jobs lookup', jobsErr)
    return { ok: false, error: 'Failed to look up owning jobs.' }
  }

  const userEmail = user.email.toLowerCase()
  for (const job of (jobs ?? []) as Array<{ id: string; created_by_email: string | null }>) {
    const owner = job.created_by_email?.toLowerCase() ?? null
    if (owner !== userEmail) {
      return { ok: false, error: 'You do not own one or more of the selected leads.' }
    }
  }

  return { ok: true, user_id: user.id, email: user.email, is_admin: false }
}

type Svc = ReturnType<typeof createServiceClient>

async function checkJobOwnership(
  svc: Svc,
  jobId: string,
  userId: string,
  userEmail: string | null,
): Promise<LeadAccessCheck> {
  const { data: job, error: jobErr } = await svc
    .from('scrape_queue')
    .select('created_by_email')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) {
    console.error('[requireLeadAccess] job lookup', jobErr)
    return { ok: false, error: 'Failed to look up job ownership.' }
  }
  if (!job) return { ok: false, error: 'Owning job not found.' }

  const ownerEmail = (job as { created_by_email: string | null }).created_by_email
  if (
    ownerEmail &&
    userEmail &&
    ownerEmail.toLowerCase() === userEmail.toLowerCase()
  ) {
    return { ok: true, user_id: userId, email: userEmail, is_admin: false }
  }

  const { data: isAdmin, error: adminErr } = await svc.rpc('is_admin', { p_user_id: userId })
  if (adminErr) {
    console.error('[requireLeadAccess] is_admin', adminErr)
    return { ok: false, error: 'Failed to verify admin access.' }
  }
  if (isAdmin) {
    return { ok: true, user_id: userId, email: userEmail, is_admin: true }
  }

  return { ok: false, error: 'You do not have access to this lead.' }
}
