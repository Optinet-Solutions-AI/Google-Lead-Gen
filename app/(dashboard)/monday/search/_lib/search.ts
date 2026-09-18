import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { parseRecencyBands, type RecencyBands } from '@/lib/website-profiles/recency'

export type MirrorFreshness = {
  board: string
  items: number
  updates: number
  last_synced_at: string | null
  last_monday_update: string | null
}

export type MondayHit = {
  board: string
  item_id: string
  item_name: string | null
  match_kind: string
  tier: number
  website: string | null
  monday_updated_at: string | null
  synced_at: string | null
}

export type ProfileCard = {
  id: number
  normalized_domain: string
  registered_domain: string
  display_name: string | null
  source: string
  first_lead_id: number | null
  first_seen_at: string | null
  last_seen_at: string | null
  appearance_count: number
  is_on_monday: boolean
  monday_board: string | null
  monday_item_id: string | null
  monday_match_kind: string | null
  monday_matched_at: string | null
  monday_overridden_at: string | null
  is_not_relevant: boolean
  not_relevant_source: string | null
  not_relevant_at: string | null
  system_flag: string | null
  system_flag_source: string | null
  system_flag_reason: string | null
  system_flag_at: string | null
  is_affiliate: boolean | null
  affiliate_confidence: string | null
  affiliate_checked_at: string | null
  affiliate_source: string | null
  is_affiliate_overridden_at: string | null
  is_rooster_partner: boolean | null
  brand: string | null
  rooster_checked_at: string | null
  is_rooster_overridden_at: string | null
  has_contact_details: boolean | null
  contact_checked_at: string | null
  has_s_tags: boolean | null
  s_tags_checked_at: string | null
  updated_at: string
}

export type RelatedProfile = {
  id: number
  normalized_domain: string
  relation: string
  confidence: number
  is_on_monday: boolean
  monday_board: string | null
  last_seen_at: string | null
  appearance_count: number
}

export type Appearance = {
  seen_at: string
  keyword: string | null
  country_code: string | null
  search_engine: string | null
  result_type: string | null
  url: string | null
  created_lead: boolean
  batch_id: number | null
}

export type SearchResult = {
  query: string
  normalized: string
  hits: MondayHit[]
  profile: ProfileCard | null
  related: RelatedProfile[]
  appearances: Appearance[]
  leadCount: number
}

/** Request time, taken once per render on the server (keeps the page component pure). */
export function requestNowMs(): number {
  return Date.now()
}

export async function loadMirrorFreshness(): Promise<MirrorFreshness[]> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_monday_mirror_freshness')
  return ((data ?? []) as MirrorFreshness[]).map(r => ({
    ...r,
    items: Number(r.items ?? 0),
    updates: Number(r.updates ?? 0),
  }))
}

export async function loadRecencyBands(): Promise<RecencyBands> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', { p_key: 'recency_bands_days' })
  return parseRecencyBands(data)
}

export async function searchDomain(query: string): Promise<SearchResult> {
  const svc = createServiceClient()
  const q = query.trim()
  const { data: nd } = await svc.rpc('normalize_domain', { p_input: q })
  const normalized = typeof nd === 'string' ? nd : ''

  if (!normalized) {
    return { query: q, normalized, hits: [], profile: null, related: [], appearances: [], leadCount: 0 }
  }

  const [{ data: hitRows }, { data: profileRow }] = await Promise.all([
    svc.rpc('search_website_on_monday_all', { p_domain: q }),
    svc.from('website_profiles').select('*').eq('normalized_domain', normalized).maybeSingle(),
  ])
  const hits = (hitRows ?? []) as MondayHit[]
  const profile = (profileRow ?? null) as ProfileCard | null

  if (!profile) {
    return { query: q, normalized, hits, profile, related: [], appearances: [], leadCount: 0 }
  }

  const [{ data: relRows }, { data: appRows }, { count }] = await Promise.all([
    svc
      .from('website_relations')
      .select('relation, confidence, profile_id, related_profile_id')
      .or(`profile_id.eq.${profile.id},related_profile_id.eq.${profile.id}`)
      .limit(50),
    svc
      .from('website_appearances')
      .select('seen_at, keyword, country_code, search_engine, result_type, url, created_lead, batch_id')
      .eq('profile_id', profile.id)
      .order('seen_at', { ascending: false })
      .limit(15),
    svc.from('google_lead_gen_table').select('id', { count: 'exact', head: true }).eq('profile_id', profile.id),
  ])

  const rels = (relRows ?? []) as Array<{ relation: string; confidence: number; profile_id: number; related_profile_id: number }>
  const otherIds = rels.map(r => (r.profile_id === profile.id ? r.related_profile_id : r.profile_id))
  let related: RelatedProfile[] = []
  if (otherIds.length > 0) {
    const { data: others } = await svc
      .from('website_profiles')
      .select('id, normalized_domain, is_on_monday, monday_board, last_seen_at, appearance_count')
      .in('id', otherIds)
    const byId = new Map(((others ?? []) as Array<Omit<RelatedProfile, 'relation' | 'confidence'>>).map(o => [o.id, o]))
    related = rels
      .map(r => {
        const other = byId.get(r.profile_id === profile.id ? r.related_profile_id : r.profile_id)
        return other ? { ...other, relation: r.relation, confidence: Number(r.confidence) } : null
      })
      .filter((x): x is RelatedProfile => x !== null)
      .sort((a, b) => b.confidence - a.confidence || (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''))
  }

  return {
    query: q,
    normalized,
    hits,
    profile,
    related,
    appearances: (appRows ?? []) as Appearance[],
    leadCount: count ?? 0,
  }
}

export const BOARD_SLUG: Record<string, string> = {
  leads: 'leads',
  affiliates: 'affiliates',
  not_relevant_leads: 'not-relevant-leads',
  email_undelivered_leads: 'email-undelivered-leads',
}

export const BOARD_LABEL: Record<string, string> = {
  leads: 'Leads',
  affiliates: 'Affiliates',
  not_relevant_leads: 'Not Relevant',
  email_undelivered_leads: 'Email Undelivered',
}

export const MATCH_LABEL: Record<string, string> = {
  exact: 'Website matches exactly',
  exact_name: 'Item title is this domain',
  registered: 'Same registered domain, other host',
  registered_name: 'Item title shares the registered domain',
  brand_stem: 'Same brand on another TLD',
  mentioned_in_updates: 'Mentioned in an item update',
  mentioned_in_updates_stem: 'Brand mentioned in an item update',
  s_tag_partner: 'Shares an S-tag partner',
  manual: 'Set by an operator',
}
