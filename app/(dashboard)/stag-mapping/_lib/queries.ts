import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { BOARDS } from '@/lib/monday/board-registry'

const DAY_MS = 24 * 60 * 60 * 1000

/** How many s_tags_table rows to pull on a page load. Groups happen
 *  in JS after the read. Bumped from 8k → 20k so ?days=all can cover
 *  most historical extractions without truncation for typical usage.
 *  If s_tags_table grows past ~200k, revisit. */
const MAX_ROWS = 20000
/** How many days back to look by default. All-time (`lookbackDays:
 *  null`) skips the date filter entirely — the operator gets an
 *  "older extractions dropped" banner if MAX_ROWS is exceeded. */
const DEFAULT_LOOKBACK_DAYS = 90

export type MondayBoardFreshness = {
  key: string
  label: string
  itemsTable: string
  itemCount: number
  lastSyncedAt: string | null
  ageMinutes: number | null
  isStale: boolean
}

/** Snapshot of every replicated board's freshness. Table exposes it
 *  as a banner so operators know if the S-tag matches they're looking
 *  at might be lagging behind the source. */
export async function getMondayFreshness(): Promise<MondayBoardFreshness[]> {
  const svc = createServiceClient()
  const results: MondayBoardFreshness[] = []
  for (const b of BOARDS) {
    const [{ count }, latest] = await Promise.all([
      svc.from(b.items_table).select('id', { count: 'exact', head: true }),
      svc.from(b.items_table).select('synced_at').order('synced_at', { ascending: false }).limit(1),
    ])
    const lastSyncedAt =
      latest.data && latest.data.length > 0 && (latest.data[0] as { synced_at: string | null }).synced_at
        ? (latest.data[0] as { synced_at: string }).synced_at
        : null
    const ageMinutes = lastSyncedAt
      ? Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 60_000)
      : null
    // "Stale" is > 24h — the nightly cron runs incremental syncs, so
    // anything older than one day means the cron missed or the token
    // needs refreshing.
    const isStale = ageMinutes === null || ageMinutes > 24 * 60
    results.push({
      key: b.key,
      label: b.monday_board_name,
      itemsTable: b.items_table,
      itemCount: count ?? 0,
      lastSyncedAt,
      ageMinutes,
      isStale,
    })
  }
  return results
}

export type StagLead = {
  leadId: number
  url: string | null
  domain: string | null
  countryCode: string | null
  isOnMonday: boolean | null
  mondayBoard: string | null
  mondayItemId: string | null
  createdAt: string
  scrapeJobId: string | null
}

export type StagGroup = {
  sTag: string
  sourceParam: string | null
  brand: string | null
  leadCount: number
  domainCount: number
  domains: string[]
  firstSeen: string
  lastSeen: string
  /** True when at least one tag row for this s_tag is mapped to a Monday item. */
  isOnMonday: boolean
  mondayMatchKind: 'item' | 'updates' | null
  /** Distinct Monday item IDs this s_tag maps to (usually 0 or 1; 2+ = split affiliate). */
  mondayItemIds: string[]
  leads: StagLead[]
}

export type StagSummary = {
  totalUniqueTags: number
  mappedCount: number
  unmappedCount: number
  mirrorGroups: number
  totalWebsites: number
  totalLeadsWithTags: number
}

export type StagMappingData = {
  generatedAt: string
  /** null = all-time (no date filter applied). Any number = last N days. */
  lookbackDays: number | null
  freshness: MondayBoardFreshness[]
  summary: StagSummary
  groups: StagGroup[]
  /** True when the underlying row-fetch hit MAX_ROWS — the caller can
   *  warn the operator that older extractions were dropped. */
  truncated: boolean
}

function extractDomain(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url.split('/')[0]?.replace(/^www\./, '') ?? null
  }
}

export async function loadStagMappingData(options: {
  /** number = last N days (clamped 1..365). null = all-time (no date
   *  filter). undefined = use DEFAULT_LOOKBACK_DAYS. */
  lookbackDays?: number | null
} = {}): Promise<StagMappingData> {
  const svc = createServiceClient()
  const raw = options.lookbackDays === undefined ? DEFAULT_LOOKBACK_DAYS : options.lookbackDays
  const lookbackDays: number | null =
    raw === null ? null : Math.max(1, Math.min(365, raw))

  // Two reads: freshness (cheap, cached-friendly) + the tag+lead join
  // (bounded by MAX_ROWS, ordered by newest first so recent activity
  // always wins if we hit the cap).
  let tagQuery = svc
    .from('s_tags_table')
    .select(
      `id, lead_id, s_tag, source_param, brand, is_existing_on_monday,
       monday_match_kind, monday_match_item_id, created_at,
       lead:google_lead_gen_table!inner (
         id, url, country_code, is_on_monday, monday_board, monday_item_id, scrape_job_id
       )`,
    )
    .not('s_tag', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)
  if (lookbackDays !== null) {
    const since = new Date(Date.now() - lookbackDays * DAY_MS).toISOString()
    tagQuery = tagQuery.gte('created_at', since)
  }

  const [freshness, tagsResult] = await Promise.all([
    getMondayFreshness(),
    tagQuery,
  ])

  type TagRow = {
    id: number
    lead_id: number
    s_tag: string
    source_param: string | null
    brand: string | null
    is_existing_on_monday: boolean | null
    monday_match_kind: 'item' | 'updates' | null
    monday_match_item_id: string | null
    created_at: string
    lead: {
      id: number
      url: string | null
      country_code: string | null
      is_on_monday: boolean | null
      monday_board: string | null
      monday_item_id: string | null
      scrape_job_id: string | null
    } | null
  }
  const rows = (tagsResult.data as unknown as TagRow[] | null) ?? []
  const truncated = rows.length >= MAX_ROWS

  // Group by s_tag (case-insensitive to catch same-value/different-case).
  const byTag = new Map<string, StagGroup>()
  for (const r of rows) {
    const key = r.s_tag.toLowerCase()
    let g = byTag.get(key)
    if (!g) {
      g = {
        sTag: r.s_tag,
        sourceParam: r.source_param,
        brand: r.brand,
        leadCount: 0,
        domainCount: 0,
        domains: [],
        firstSeen: r.created_at,
        lastSeen: r.created_at,
        isOnMonday: false,
        mondayMatchKind: null,
        mondayItemIds: [],
        leads: [],
      }
      byTag.set(key, g)
    }
    if (r.source_param && !g.sourceParam) g.sourceParam = r.source_param
    if (r.brand && !g.brand) g.brand = r.brand
    if (r.created_at < g.firstSeen) g.firstSeen = r.created_at
    if (r.created_at > g.lastSeen) g.lastSeen = r.created_at
    if (r.is_existing_on_monday) g.isOnMonday = true
    if (r.monday_match_kind && !g.mondayMatchKind) g.mondayMatchKind = r.monday_match_kind
    if (r.monday_match_item_id && !g.mondayItemIds.includes(r.monday_match_item_id)) {
      g.mondayItemIds.push(r.monday_match_item_id)
    }
    if (r.lead) {
      const domain = extractDomain(r.lead.url)
      g.leads.push({
        leadId: r.lead.id,
        url: r.lead.url,
        domain,
        countryCode: r.lead.country_code,
        isOnMonday: r.lead.is_on_monday,
        mondayBoard: r.lead.monday_board,
        mondayItemId: r.lead.monday_item_id,
        createdAt: r.created_at,
        scrapeJobId: r.lead.scrape_job_id,
      })
      if (domain && !g.domains.includes(domain)) g.domains.push(domain)
    }
  }

  const groups = Array.from(byTag.values()).map(g => {
    g.leadCount = g.leads.length
    g.domainCount = g.domains.length
    // Newest leads first inside the expand-row.
    g.leads.sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))
    return g
  })
  // Default sort: mirror groups (2+ domains) first, then by lead-count desc.
  groups.sort((a, b) => {
    const aMirror = a.domainCount >= 2 ? 1 : 0
    const bMirror = b.domainCount >= 2 ? 1 : 0
    if (aMirror !== bMirror) return bMirror - aMirror
    if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount
    return b.lastSeen < a.lastSeen ? -1 : 1
  })

  const totalUniqueTags = groups.length
  const mappedCount = groups.filter(g => g.isOnMonday).length
  const unmappedCount = totalUniqueTags - mappedCount
  const mirrorGroups = groups.filter(g => g.domainCount >= 2).length
  const totalWebsites = new Set(groups.flatMap(g => g.domains)).size
  const totalLeadsWithTags = groups.reduce((sum, g) => sum + g.leadCount, 0)

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    freshness,
    summary: {
      totalUniqueTags,
      mappedCount,
      unmappedCount,
      mirrorGroups,
      totalWebsites,
      totalLeadsWithTags,
    },
    groups,
    truncated,
  }
}
