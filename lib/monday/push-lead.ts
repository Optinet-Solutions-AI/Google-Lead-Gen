import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { MondayApiError, mondayGQL } from '@/lib/monday/graphql'

export const LEADS_BOARD_ID = '1236073873'
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file'
const API_VERSION = '2025-07'

export type PushResult = {
  ok: true
  monday_item_id: string
  attached_file: boolean
  s_tag_update_posted: boolean
  /** Non-null when the Monday item was created successfully but the local
   *  "already pushed" stamp update failed. The push is still ok — the
   *  caller should surface this so the user doesn't click Push again
   *  (which would create a duplicate item on the Leads board). */
  stamp_warning: string | null
}

export type PushError = {
  ok: false
  error: string
}

/** Everything the push needs after the read-only preparation phase.
 *  `prepareLeadPushPayload` builds this; `pushLeadToMonday` consumes it
 *  to perform the writes. The dry-run script in `scripts/monday/dry-push.ts`
 *  prints it instead, which lets us verify the request shape, owner ID,
 *  and positioning anchor without touching Monday. */
export type PreparedPushPayload = {
  /** Exact column_values dict that will be JSON.stringified into create_item.cv. */
  columnValues: Record<string, unknown>
  /** Item name (cleaned domain or `lead-${id}` fallback). */
  itemName: string
  /** Topmost (group, item) so create_item can be positioned before_at it.
   *  null when the board has no groups, top group is empty, or the API
   *  call failed — in that case we fall back to a plain create_item. */
  anchor: { groupId: string; itemId: string } | null
  /** Resolved metadata, surfaced for the dry-run printout + logging. */
  meta: {
    leadId: number
    domain: string
    primaryEmail: string
    sTagsCount: number
    ownerId: number
    pushedBy: string
    source: 'PPC' | 'SEO'
  }
  /** Lead row + s-tags retained so the caller can do post-create
   *  steps (screenshot upload, s-tag update) without re-querying. */
  lead: {
    id: number
    url: string | null
    domain: string | null
    screenshot_content_link: string | null
  }
  stags: Array<{ s_tag: string; brand: string | null }>
}

/**
 * Read-only phase of the push: fetch the lead + contact + s-tags, build
 * the create_item column_values dict, and resolve the top-of-board anchor.
 *
 * Safe to call independently of pushLeadToMonday — used by the dry-run
 * script to verify request shape without writing to Monday.
 */
export async function prepareLeadPushPayload(
  leadId: number,
  opts: { pushedBy: string; pushedByMondayId: number },
): Promise<{ ok: true; data: PreparedPushPayload } | PushError> {
  if (!opts.pushedByMondayId || !Number.isFinite(opts.pushedByMondayId)) {
    return {
      ok: false,
      error:
        'Your account is not linked to a Monday user. Ask an admin to set your Monday ID at /admin/users so pushes land under you.',
    }
  }

  const svc = createServiceClient()

  const { data: lead, error: leadErr } = await svc
    .from('google_lead_gen_table')
    .select(
      [
        'id, url, domain, keyword, country_code, result_type',
        'brand, screenshot_content_link',
        'pushed_to_monday_at, monday_pushed_item_id',
      ].join(', '),
    )
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return { ok: false, error: leadErr.message }
  if (!lead) return { ok: false, error: `Lead ${leadId} not found.` }

  const l = lead as unknown as {
    id: number
    url: string | null
    domain: string | null
    keyword: string | null
    country_code: string | null
    result_type: string | null
    brand: string | null
    screenshot_content_link: string | null
    pushed_to_monday_at: string | null
    monday_pushed_item_id: string | null
  }

  if (l.pushed_to_monday_at) {
    return {
      ok: false,
      error: `Already pushed to Monday on ${l.pushed_to_monday_at} (item ${l.monday_pushed_item_id}).`,
    }
  }

  // Pull the latest contact + every s-tag in parallel.
  const [contactRes, stagsRes] = await Promise.all([
    svc
      .from('contact_table')
      .select('emails')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc
      .from('s_tags_table')
      .select('s_tag, brand')
      .eq('lead_id', leadId)
      .order('id', { ascending: true }),
  ])

  const primaryEmail =
    ((contactRes.data as { emails: string[] | null } | null)?.emails ?? [])[0] ?? ''
  const stags = (stagsRes.data ?? []) as Array<{ s_tag: string; brand: string | null }>

  const cleanDomain = stripDomain(l.domain ?? l.url ?? '')
  const source: 'PPC' | 'SEO' = l.result_type === 'PPC' ? 'PPC' : 'SEO'
  const todayIso = new Date().toISOString().slice(0, 10)

  const columnValues: Record<string, unknown> = {
    text86: sanitize(l.brand ?? ''),
    text54: sanitize(l.keyword ?? ''),
    status: { label: 'New Lead' },
    email: primaryEmail
      ? { email: primaryEmail, text: primaryEmail }
      : null,
    status_12: { label: null },
    status_1: { label: source },
    text0: sanitize(l.country_code ?? ''),
    date: { date: todayIso },
    text1: sanitize(l.url ?? ''),
    project_owner: {
      personsAndTeams: [{
        id: opts.pushedByMondayId,
        kind: 'person',
      }],
    },
  }

  const anchor = await fetchTopAnchor(LEADS_BOARD_ID)

  return {
    ok: true,
    data: {
      columnValues,
      itemName: cleanDomain || `lead-${leadId}`,
      anchor,
      meta: {
        leadId,
        domain: cleanDomain,
        primaryEmail,
        sTagsCount: stags.length,
        ownerId: opts.pushedByMondayId,
        pushedBy: opts.pushedBy,
        source,
      },
      lead: {
        id: l.id,
        url: l.url,
        domain: l.domain,
        screenshot_content_link: l.screenshot_content_link,
      },
      stags,
    },
  }
}

/**
 * Pushes one lead onto the Rooster Partners "Leads" board on Monday.com.
 *
 * Mirrors the legacy n8n "Add Lead on Monday.com" workflow (catalogued
 * in docs/n8n-workflows-catalog.md §2.18) — same board, same column ids,
 * same status label, same "PPC" vs "SEO" mapping.
 *
 * Three steps:
 *   1. create_item with the column_values from the legacy spec, positioned
 *      `before_at` the current top item so it lands above existing rows.
 *   2. If a screenshot exists in Storage, download it and POST a
 *      multipart add_file_to_column request to attach it.
 *   3. If s-tags exist, build a multi-line "<brand> <s_tag>" body and
 *      post create_update on the new item.
 *
 * Stamps pushed_to_monday_at + monday_pushed_item_id back on the lead
 * row so the UI can show "already pushed" and prevent double-pushing.
 */
export async function pushLeadToMonday(
  leadId: number,
  opts: {
    pushedBy: string
    /** Monday user ID of the operator clicking Push. Lands as the
     *  Owner on the new item via the project_owner column. Required:
     *  the action layer must block the push and surface a "link your
     *  Monday account" error when `user_profiles.monday_user_id` is
     *  null, instead of silently impersonating a default owner. */
    pushedByMondayId: number
  },
): Promise<PushResult | PushError> {
  const prepared = await prepareLeadPushPayload(leadId, opts)
  if (!prepared.ok) return prepared
  const { columnValues, itemName, anchor, lead, stags } = prepared.data

  const svc = createServiceClient()

  // ----- Step 1: create_item -----
  // Anchor for "land on top": Monday's create_item inserts at the
  // bottom of its group by default, so the old "+1 day on the date
  // column" trick only worked when the operator's board view was
  // sorted by date — which it isn't reliably. Native fix is to pass
  // position_relative_method=before_at with the current first item
  // of the top group as relative_to. Best-effort: if the anchor
  // query failed or the group is empty, fall through to a plain
  // create_item (bottom of group, same as before).
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
            create_item(board_id: $board_id, item_name: $item_name, column_values: $cv) {
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

  // ----- Step 2: optional screenshot upload -----
  let attachedFile = false
  if (lead.screenshot_content_link) {
    try {
      const { data: blob, error: dlErr } = await svc.storage
        .from('lead-screenshots')
        .download(lead.screenshot_content_link)
      if (!dlErr && blob) {
        await uploadFileToMondayColumn(createdItemId, 'files', blob, fileNameFor(lead))
        attachedFile = true
      }
    } catch {
      // Non-fatal — item is already created; log via the DB stamp below
      // and let the user retry attachment manually if needed.
    }
  }

  // ----- Step 3: s-tags as an item update -----
  let sTagUpdatePosted = false
  if (stags.length > 0) {
    const body = stags
      .map(t => `${(t.brand ?? '').trim()} ${(t.s_tag ?? '').trim()}`)
      .filter(line => line.trim().length > 0)
      .join('\n')
    if (body.length > 0) {
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
  }

  // ----- Stamp the lead row so the UI shows "already pushed" -----
  // The Monday item is already created at this point — we cannot fail
  // the push on a stamp error. Retry on transient failures (rate-limit,
  // brief network blip) before giving up: the UI reads this stamp to
  // hide the Push button, so an unstamped row leaves the button visible
  // and the next click creates a duplicate item on the Leads board.
  //
  // Three attempts: immediate, +300ms, +1000ms. Max ~1.3s extra latency
  // when all three fail, which is acceptable on top of the Monday push
  // the user just waited for. If all three fail, surface the error via
  // stamp_warning so the user knows not to retry.
  const stampPatch = {
    pushed_to_monday_at: new Date().toISOString(),
    monday_pushed_item_id: createdItemId,
    monday_pushed_by: opts.pushedBy,
  }
  const STAMP_DELAYS_MS = [0, 300, 1000]
  let stampErr: { message: string } | null = null
  let stampAttempts = 0
  for (const delay of STAMP_DELAYS_MS) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    stampAttempts++
    const { error } = await svc
      .from('google_lead_gen_table')
      .update(stampPatch)
      .eq('id', leadId)
    if (!error) {
      stampErr = null
      break
    }
    stampErr = error
  }

  return {
    ok: true,
    monday_item_id: createdItemId,
    attached_file: attachedFile,
    s_tag_update_posted: sTagUpdatePosted,
    stamp_warning: stampErr
      ? `${stampErr.message} (after ${stampAttempts} attempt${stampAttempts === 1 ? '' : 's'})`
      : null,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip protocol + www + trailing slash to match the legacy item-name format. */
function stripDomain(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

/** Remove characters that break Monday's JSON column-values payload. */
function sanitize(s: string): string {
  return s.replace(/["'\n\r\\]/g, '').trim()
}

/**
 * Resolve the topmost item in the board's first non-empty group so
 * create_item can be positioned `before_at` it. Returns null when the
 * board has no groups, every group is empty, or the API call fails —
 * callers fall through to a plain create_item in that case.
 */
async function fetchTopAnchor(
  boardId: string,
): Promise<{ groupId: string; itemId: string } | null> {
  try {
    const data = await mondayGQL<{
      boards: Array<{
        groups: Array<{
          id: string
          items_page: { items: Array<{ id: string }> }
        }> | null
      }> | null
    }>(
      `query ($board: [ID!]) {
        boards(ids: $board) {
          groups {
            id
            items_page(limit: 1) { items { id } }
          }
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

function fileNameFor(l: { domain: string | null; url: string | null; id: number }): string {
  const stem = stripDomain(l.domain ?? l.url ?? '') || `lead-${l.id}`
  return `${stem}.png`
}

/**
 * Multipart file upload to Monday's GraphQL endpoint. Monday expects
 * a specific shape: a `query` field with the mutation, `variables`
 * with a placeholder for the file, `map` declaring the file binding,
 * and the binary field named "0".
 */
async function uploadFileToMondayColumn(
  itemId: string,
  columnId: string,
  blob: Blob,
  filename: string,
): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN is not set')

  const query = `mutation ($file: File!, $item_id: ID!, $column_id: String!) {
    add_file_to_column(item_id: $item_id, column_id: $column_id, file: $file) { id }
  }`

  const form = new FormData()
  form.append('query', query)
  form.append(
    'variables',
    JSON.stringify({ file: null, item_id: itemId, column_id: columnId }),
  )
  form.append('map', JSON.stringify({ '0': ['variables.file'] }))
  form.append('0', blob, filename)

  const res = await fetch(FILE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: token,
      'API-Version': API_VERSION,
    },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new MondayApiError(
      `add_file_to_column HTTP ${res.status}`,
      res.status,
      text,
    )
  }
  const body = (await res.json()) as { errors?: Array<{ message: string }> }
  if (body.errors?.length) {
    throw new MondayApiError(
      `add_file_to_column errors: ${body.errors.map(e => e.message).join('; ')}`,
      res.status,
      body,
    )
  }
}
