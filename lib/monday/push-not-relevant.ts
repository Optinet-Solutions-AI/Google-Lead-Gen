import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { mondayGQL } from '@/lib/monday/graphql'
import { BOARDS } from '@/lib/monday/board-registry'

/**
 * Push a lead to Monday's Not Relevant board.
 *
 * Much simpler than pushLeadToMonday for the main Leads board: the
 * not_relevant board only needs the domain name + a handful of
 * context columns. We don't attach screenshots or post s-tag updates;
 * the board exists purely to keep a record of "we've already decided
 * this lead is junk, don't surface it again", so future scrapes
 * matching the same domain auto-skip via mark_monday_duplicates.
 *
 * Idempotency: if the lead already has `monday_pushed_item_id` set
 * AND `monday_board='not_relevant_leads'` we return ok without
 * hitting Monday again. The board ID is sourced from board-registry
 * so a re-numbering on Monday's side is a one-file fix.
 */
export type PushNotRelevantResult =
  | { ok: true; monday_item_id: string }
  | { ok: false; error: string }

function getNotRelevantBoardId(): string | null {
  const cfg = BOARDS.find(b => b.key === 'not_relevant_leads')
  return cfg?.monday_board_id ?? null
}

function stripDomain(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

function sanitize(s: string): string {
  // Same JSON-safety rule as push-lead.ts — Monday's column_values
  // payload is JSON-stringified so quote / newline / backslash break it.
  return s.replace(/["'\n\r\\]/g, '').trim()
}

export async function pushLeadToMondayNotRelevant(
  leadId: number,
  opts: {
    pushedBy: string
    /** Monday user_id of the operator pushing. Used to assign the Owner
     *  column on the created item so a quick glance on Monday shows
     *  who flagged it. Required — we'd rather fail than silently push
     *  un-owned items. */
    pushedByMondayId: number
    note?: string
  },
): Promise<PushNotRelevantResult> {
  const svc = createServiceClient()
  const boardId = getNotRelevantBoardId()
  if (!boardId) {
    return { ok: false, error: 'Not Relevant board ID missing from board-registry.' }
  }

  // Lead + first-known contact email (best-effort, single row).
  const { data: leadRow, error: leadErr } = await svc
    .from('google_lead_gen_table')
    .select('id, url, domain, keyword, country, country_code, monday_pushed_item_id, monday_board')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return { ok: false, error: leadErr.message }
  if (!leadRow) return { ok: false, error: 'Lead not found.' }

  const row = leadRow as {
    id: number
    url: string | null
    domain: string | null
    keyword: string | null
    country: string | null
    country_code: string | null
    monday_pushed_item_id: string | null
    monday_board: string | null
  }

  // Idempotency — don't double-push to the same board.
  if (row.monday_pushed_item_id && row.monday_board === 'not_relevant_leads') {
    return { ok: true, monday_item_id: row.monday_pushed_item_id }
  }

  const cleanedDomain = stripDomain(row.domain ?? row.url ?? '')
  const itemName = cleanedDomain || `lead-${row.id}`
  const website = sanitize(row.url ?? '')

  // Column ids mirror the not_relevant_leads column_map in
  // board-registry: text54 keywords, text0 geo, text1 website,
  // text82 comments, status status, project_owner owner.
  const columnValues: Record<string, unknown> = {
    text54: sanitize(row.keyword ?? ''),
    text0: sanitize(row.country ?? row.country_code ?? ''),
    text1: website,
    // Status label — defaults to "New" on Monday without this. Set
    // explicitly so the board shows the correct intent at a glance.
    // create_labels_if_missing on the mutation below auto-creates the
    // label if it doesn't exist yet, so a fresh board still works.
    status: { label: 'Not relevant' },
    // Owner = the operator who pushed. Same pattern as push-lead.ts.
    project_owner: {
      personsAndTeams: [{ id: opts.pushedByMondayId, kind: 'person' }],
    },
  }
  if (opts.note) {
    columnValues.text82 = sanitize(opts.note.slice(0, 500))
  }

  let createdItemId: string
  try {
    const data = await mondayGQL<{ create_item: { id: string } }>(
      `mutation ($board_id: ID!, $item_name: String!, $cv: JSON!) {
        create_item(
          board_id: $board_id,
          item_name: $item_name,
          column_values: $cv,
          create_labels_if_missing: true
        ) { id }
      }`,
      {
        board_id: boardId,
        item_name: itemName,
        cv: JSON.stringify(columnValues),
      },
    )
    createdItemId = data.create_item.id
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `create_item failed: ${msg}` }
  }

  // Stamp the lead row: now on the not-relevant board, hidden from
  // /leads by default (is_not_relevant=true), enrichment chain
  // skips it forever (unless an operator hits Force enrich).
  const nowIso = new Date().toISOString()
  const { error: updErr } = await svc
    .from('google_lead_gen_table')
    .update({
      is_not_relevant: true,
      not_relevant_marked_at: nowIso,
      not_relevant_marked_by: opts.pushedBy,
      is_on_monday: true,
      monday_board: 'not_relevant_leads',
      monday_item_id: createdItemId,
      monday_pushed_item_id: createdItemId,
      monday_pushed_by: opts.pushedBy,
      pushed_to_monday_at: nowIso,
    })
    .eq('id', leadId)
  if (updErr) {
    // Item exists on Monday; we just couldn't update the stamp.
    // Return a soft warning by mixing into the error message.
    return {
      ok: false,
      error: `Created Monday item ${createdItemId} but failed to stamp local row: ${updErr.message}`,
    }
  }

  return { ok: true, monday_item_id: createdItemId }
}
