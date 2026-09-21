'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'
import { requireLeadsAccess } from '@/lib/auth/require-lead-access'

/**
 * Website-wide operator actions.
 *
 * "Not relevant" is a judgement about a WEBSITE — a porn site or a news
 * outlet doesn't become relevant because a different keyword found it. So
 * these apply to every lead row for the domain at once, rather than making
 * an operator hunt down the same site across a dozen batches. The verdict
 * is also written onto the profile, which is what future scrapes read.
 */

export type WebsiteActionState =
  | { status: 'idle' }
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }

const LEAD_IDS_CAP = 500

function parseIds(fd: FormData): number[] {
  const raw = String(fd.get('lead_ids') ?? '').trim()
  if (!raw) return []
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isInteger(n) && n > 0),
    ),
  ).slice(0, LEAD_IDS_CAP)
}

export async function setWebsiteNotRelevantAction(
  _prev: WebsiteActionState,
  fd: FormData,
): Promise<WebsiteActionState> {
  const leadIds = parseIds(fd)
  const domain = String(fd.get('domain') ?? '').trim().toLowerCase()
  if (leadIds.length === 0) return { status: 'error', error: 'No appearances to update.' }

  const access = await requireLeadsAccess(leadIds)
  if (!access.ok) return { status: 'error', error: access.error }

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const wantsTrue = String(fd.get('value') ?? '').toLowerCase() === 'true'

  const svc = createServiceClient()
  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('username, display_name')
    .eq('id', user.id)
    .maybeSingle()
  const profile = profileRow as { username: string | null; display_name: string | null } | null
  const markedBy = profile?.display_name ?? profile?.username ?? user.email ?? user.id

  const update = wantsTrue
    ? {
        is_not_relevant: true,
        not_relevant_marked_at: new Date().toISOString(),
        not_relevant_marked_by: markedBy,
      }
    : {
        is_not_relevant: false,
        not_relevant_marked_at: null,
        not_relevant_marked_by: null,
      }

  const { error: updErr } = await svc
    .from('google_lead_gen_table')
    .update(update)
    .in('id', leadIds)
  if (updErr) return { status: 'error', error: 'Failed to update the appearances.' }

  // The profile is what the next scrape consults, so keep it in step.
  if (domain) {
    await svc
      .from('website_profiles')
      .update(
        wantsTrue
          ? { is_not_relevant: true, not_relevant_source: 'manual', not_relevant_at: new Date().toISOString() }
          : { is_not_relevant: false, not_relevant_source: null, not_relevant_at: null },
      )
      .eq('normalized_domain', domain)
  }

  await logActivity({
    action: wantsTrue ? 'website.mark_not_relevant' : 'website.unmark_not_relevant',
    entity_type: 'website',
    details: { domain, appearances: leadIds.length, marked_by: markedBy },
  })

  revalidatePath('/leads')
  revalidatePath('/scrape', 'layout')
  if (domain) revalidatePath(`/websites/${domain}`)

  const n = leadIds.length
  return {
    status: 'ok',
    message: wantsTrue
      ? `Marked ${domain || 'this website'} not relevant (${n} appearance${n === 1 ? '' : 's'}).`
      : `Cleared the not-relevant flag (${n} appearance${n === 1 ? '' : 's'}).`,
  }
}
