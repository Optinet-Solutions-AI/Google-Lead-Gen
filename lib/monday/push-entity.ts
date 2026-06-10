import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { mondayGQL } from '@/lib/monday/graphql'
import { MAX_OPERATOR_NOTE_LEN } from '@/lib/monday/push-constants'
import { LEADS_BOARD_ID } from '@/lib/monday/push-lead'
import {
  ENGINE_CONFIGS,
  type EngineEntityConfig,
  type SocialEngine,
} from '@/lib/monday/engine-config'

/**
 * Generic per-entity Push to Monday for the 8 social engines (everything
 * except Google/Bing, which keep using lib/monday/push-lead.ts over
 * google_lead_gen_table).
 *
 * Mirrors the per-lead push shape: build column_values for the Rooster
 * "Leads" board, create_item positioned at the top, optionally post the
 * entity's s-tags as an item update, then stamp pushed_to_monday_at /
 * monday_pushed_item_id / monday_pushed_by on the engine's own table so we
 * never double-push.
 *
 * The board column ids are the same legacy ids the per-lead push uses
 * (text86 brand, text54 keywords, status, email, status_1 Source, text0
 * Geo, date, text1 Website, project_owner). The only extra wrinkle vs the
 * lead push is `create_labels_if_missing: true` on create_item, so the new
 * per-engine Source labels ("YouTube", "TikTok", …) auto-create on the
 * board instead of erroring.
 */

export type EntityPushResult = {
  ok: true
  monday_item_id: string
  s_tag_update_posted: boolean
}
export type EntityPushError = { ok: false; error: string }

/** A push candidate gathered for a job: the entity row id + a display label
 *  for logs/dry-run. */
export type EntityCandidate = {
  id: string
  label: string
  alreadyPushed: boolean
}

type EntityRow = Record<string, unknown> & { id: string }

/** Select list for an engine's entity row: id + the columns the push reads. */
function entitySelect(cfg: EngineEntityConfig): string {
  const cols = new Set<string>(['id', 'discovered_from_keyword', 'is_likely_affiliate'])
  for (const c of cfg.nameCols) cols.add(c)
  cols.add(cfg.profileUrlCol)
  if (cfg.emailCol) cols.add(cfg.emailCol)
  if (cfg.bioLinkCol) cols.add(cfg.bioLinkCol)
  if (cfg.hasNotRelevant) cols.add('is_not_relevant')
  return Array.from(cols).join(', ')
}

function str(row: EntityRow, col: string | null): string {
  if (!col) return ''
  const v = row[col]
  return typeof v === 'string' ? v : ''
}

/** Remove characters that break Monday's JSON column-values payload.
 *  (Same rule as push-lead.ts; duplicated here to avoid touching the
 *  heavily-QA'd per-lead file.) */
function sanitize(s: string): string {
  return s.replace(/["'\n\r\\]/g, '').trim()
}

/** Strip protocol + www + trailing slash — used for the funnel-link display
 *  and as a last-resort item name. */
function stripDomain(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

/**
 * Top-of-board anchor so create_item lands above existing rows (same as the
 * per-lead push). Returns null when the board has no groups / the call fails
 * — caller falls through to a plain create_item.
 */
async function fetchTopAnchor(
  boardId: string,
): Promise<{ groupId: string; itemId: string } | null> {
  try {
    const data = await mondayGQL<{
      boards: Array<{
        groups: Array<{ id: string; items_page: { items: Array<{ id: string }> } }> | null
      }> | null
    }>(
      `query ($board: [ID!]) {
        boards(ids: $board) {
          groups { id items_page(limit: 1) { items { id } } }
        }
      }`,
      { board: [boardId] },
    )
    const groups = data.boards?.[0]?.groups ?? []
    for (const g of groups) {
      const firstItem = g.items_page?.items?.[0]
      if (firstItem) return { groupId: g.id, itemId: firstItem.id }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Gather the entities for a job that are worth pushing: likely affiliates,
 * not gated out as irrelevant, and not already pushed. Centralised here so
 * the candidate predicate is defined in exactly one place (the dry-run
 * script and the live push both read it).
 */
export async function gatherEntityCandidates(
  engine: SocialEngine,
  jobId: string,
): Promise<EntityCandidate[]> {
  const cfg = ENGINE_CONFIGS[engine]
  const svc = createServiceClient()
  const cols = new Set<string>([
    'id',
    'is_likely_affiliate',
    'pushed_to_monday_at',
    ...cfg.nameCols,
  ])
  if (cfg.hasNotRelevant) cols.add('is_not_relevant')
  const { data, error } = await svc
    .from(cfg.table)
    .select(Array.from(cols).join(', '))
    .eq('scrape_queue_id', jobId)
  if (error) throw error

  const rows = (data ?? []) as unknown as Array<
    Record<string, unknown> & {
      id: string
      is_likely_affiliate: boolean | null
      pushed_to_monday_at: string | null
      is_not_relevant?: boolean | null
    }
  >

  const out: EntityCandidate[] = []
  for (const r of rows) {
    if (r.is_likely_affiliate !== true) continue
    if (cfg.hasNotRelevant && r.is_not_relevant === true) continue
    const label =
      cfg.nameCols.map(c => (typeof r[c] === 'string' ? (r[c] as string) : '')).find(Boolean) ||
      `${engine}-${r.id}`
    out.push({
      id: r.id,
      label,
      alreadyPushed: r.pushed_to_monday_at != null,
    })
  }
  return out
}

export type PreparedEntityPayload = {
  columnValues: Record<string, unknown>
  itemName: string
  anchor: { groupId: string; itemId: string } | null
  sTagPairs: Array<{ brand: string; s_tag: string }>
  meta: { engine: SocialEngine; brand: string; email: string; website: string }
}

/**
 * Read-only phase: fetch the entity row + its links, resolve the funnel
 * link / brand / s-tags, and build the create_item column_values. Safe to
 * call from the dry-run script (no writes).
 */
export async function prepareEntityPushPayload(
  engine: SocialEngine,
  rowId: string,
  opts: { jobKeyword: string; jobCountry: string; ownerId: number; note?: string },
): Promise<{ ok: true; data: PreparedEntityPayload } | EntityPushError> {
  const cfg = ENGINE_CONFIGS[engine]
  const svc = createServiceClient()

  const { data: entity, error: entErr } = await svc
    .from(cfg.table)
    .select(entitySelect(cfg))
    .eq('id', rowId)
    .maybeSingle()
  if (entErr) return { ok: false, error: entErr.message }
  if (!entity) return { ok: false, error: `${cfg.table} row ${rowId} not found.` }
  const row = entity as unknown as EntityRow

  // Links: resolved funnel url + brand (+ s_tag where the engine has it).
  const linkCols = ['resolved_url', 'url', cfg.linkBrandCol]
  if (cfg.linkHasStag) linkCols.push('s_tag')
  const { data: linkData } = await svc
    .from(cfg.linksTable)
    .select(linkCols.join(', '))
    .eq(cfg.linksFk, rowId)
  const links = (linkData ?? []) as unknown as Array<Record<string, unknown>>

  const firstFunnel = links.find(l => l.resolved_url || l.url)
  const funnelUrl = firstFunnel
    ? String(firstFunnel.resolved_url || firstFunnel.url || '')
    : ''
  const brand =
    (links.map(l => (typeof l[cfg.linkBrandCol] === 'string' ? (l[cfg.linkBrandCol] as string) : ''))
      .find(Boolean) ?? '')

  const profileUrl = str(row, cfg.profileUrlCol)
  const bioLink = str(row, cfg.bioLinkCol)
  // Website (text1): prefer a resolved affiliate funnel link, then the
  // entity's own link-in-bio/website, then the public profile URL.
  const website = funnelUrl || bioLink || profileUrl

  const email = str(row, cfg.emailCol)
  const itemName =
    cfg.nameCols.map(c => str(row, c)).find(Boolean) ||
    stripDomain(website) ||
    `${engine}-${rowId}`
  const keyword = str(row, 'discovered_from_keyword') || opts.jobKeyword
  const todayIso = new Date().toISOString().slice(0, 10)

  const operatorNote = (opts.note ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_OPERATOR_NOTE_LEN)

  const columnValues: Record<string, unknown> = {
    text86: sanitize(brand),
    text54: sanitize(keyword),
    status: { label: 'New Lead' },
    email: email ? { email, text: email } : null,
    status_1: { label: cfg.sourceLabel },
    text0: sanitize(opts.jobCountry),
    date: { date: todayIso },
    text1: sanitize(website),
    ...(operatorNote ? { text82: operatorNote } : {}),
    project_owner: { personsAndTeams: [{ id: opts.ownerId, kind: 'person' }] },
  }

  // s-tag update body — only for engines whose links carry s_tag, and only
  // rows with both a brand and an s_tag (a one-sided "brand " line renders
  // garbled and breaks downstream parsers, same rule as the lead push).
  const flatten = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  const sTagPairs: Array<{ brand: string; s_tag: string }> = []
  if (cfg.linkHasStag) {
    for (const l of links) {
      const b = flatten(typeof l[cfg.linkBrandCol] === 'string' ? (l[cfg.linkBrandCol] as string) : '')
      const s = flatten(typeof l.s_tag === 'string' ? (l.s_tag as string) : '')
      if (b && s) sTagPairs.push({ brand: b, s_tag: s })
    }
  }

  return {
    ok: true,
    data: {
      columnValues,
      itemName,
      anchor: null, // filled in by pushEntityToMonday (skipped for dry-run)
      sTagPairs,
      meta: { engine, brand, email, website },
    },
  }
}

/**
 * Live push: prepare the payload, create the Monday item (top of board,
 * auto-creating the Source label), post the s-tags update, and stamp the
 * engine table row. Returns the new item id.
 */
export async function pushEntityToMonday(
  engine: SocialEngine,
  rowId: string,
  opts: {
    jobKeyword: string
    jobCountry: string
    pushedBy: string
    ownerId: number
    note?: string
  },
): Promise<EntityPushResult | EntityPushError> {
  const cfg = ENGINE_CONFIGS[engine]
  const svc = createServiceClient()

  // Guard against double-push: re-read the stamp right before writing.
  const { data: stampRow } = await svc
    .from(cfg.table)
    .select('pushed_to_monday_at, monday_pushed_item_id')
    .eq('id', rowId)
    .maybeSingle()
  const existing = stampRow as { pushed_to_monday_at: string | null; monday_pushed_item_id: string | null } | null
  if (existing?.pushed_to_monday_at) {
    return {
      ok: false,
      error: `Already pushed on ${existing.pushed_to_monday_at} (item ${existing.monday_pushed_item_id}).`,
    }
  }

  const prepared = await prepareEntityPushPayload(engine, rowId, {
    jobKeyword: opts.jobKeyword,
    jobCountry: opts.jobCountry,
    ownerId: opts.ownerId,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  })
  if (!prepared.ok) return prepared
  const { columnValues, itemName, sTagPairs } = prepared.data

  const anchor = await fetchTopAnchor(LEADS_BOARD_ID)

  let createdItemId: string
  try {
    const data = anchor
      ? await mondayGQL<{ create_item: { id: string } }>(
          `mutation ($board_id: ID!, $group_id: String!, $item_name: String!, $cv: JSON!, $relative_to: ID!) {
            create_item(
              board_id: $board_id,
              group_id: $group_id,
              item_name: $item_name,
              column_values: $cv,
              create_labels_if_missing: true,
              position_relative_method: before_at,
              relative_to: $relative_to
            ) { id }
          }`,
          {
            board_id: LEADS_BOARD_ID,
            group_id: anchor.groupId,
            item_name: itemName,
            cv: JSON.stringify(columnValues),
            relative_to: anchor.itemId,
          },
        )
      : await mondayGQL<{ create_item: { id: string } }>(
          `mutation ($board_id: ID!, $item_name: String!, $cv: JSON!) {
            create_item(board_id: $board_id, item_name: $item_name, column_values: $cv, create_labels_if_missing: true) {
              id
            }
          }`,
          {
            board_id: LEADS_BOARD_ID,
            item_name: itemName,
            cv: JSON.stringify(columnValues),
          },
        )
    createdItemId = data.create_item.id
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `create_item failed: ${msg}` }
  }

  // s-tags as an item update (best-effort, item already exists).
  let sTagUpdatePosted = false
  if (sTagPairs.length > 0) {
    const body = sTagPairs.map(t => `${t.brand} ${t.s_tag}`).join('\n')
    try {
      await mondayGQL(
        `mutation ($item_id: ID!, $body: String!) {
          create_update(item_id: $item_id, body: $body) { id }
        }`,
        { item_id: createdItemId, body },
      )
      sTagUpdatePosted = true
    } catch {
      // Ignore — item exists, update posting is best-effort.
    }
  }

  // Stamp the engine row so the next pass skips it. Item is already created,
  // so a stamp failure can't fail the push — retry briefly then give up.
  const stampPatch = {
    pushed_to_monday_at: new Date().toISOString(),
    monday_pushed_item_id: createdItemId,
    monday_pushed_by: opts.pushedBy,
  }
  for (const delay of [0, 300, 1000]) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
    const { error } = await svc.from(cfg.table).update(stampPatch).eq('id', rowId)
    if (!error) break
  }

  return { ok: true, monday_item_id: createdItemId, s_tag_update_posted: sTagUpdatePosted }
}
