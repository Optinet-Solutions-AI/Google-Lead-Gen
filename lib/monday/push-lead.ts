import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { MondayApiError, mondayGQL } from '@/lib/monday/graphql'

const LEADS_BOARD_ID = '1236073873'
const DEFAULT_OWNER_ID = 46169036
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file'
const API_VERSION = '2025-07'

export type PushResult = {
  ok: true
  monday_item_id: string
  attached_file: boolean
  s_tag_update_posted: boolean
}

export type PushError = {
  ok: false
  error: string
}

/**
 * Pushes one lead onto the Rooster Partners "Leads" board on Monday.com.
 *
 * Mirrors the legacy n8n "Add Lead on Monday.com" workflow (catalogued
 * in docs/n8n-workflows-catalog.md §2.18) — same board, same column ids,
 * same hardcoded owner, same status label, same "PPC" vs "SEO" mapping.
 *
 * Three steps:
 *   1. create_item with the column_values from the legacy spec.
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
  opts?: { pushedBy?: string },
): Promise<PushResult | PushError> {
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
  const stags = ((stagsRes.data ?? []) as Array<{ s_tag: string; brand: string | null }>) ?? []

  // ----- Step 1: create_item -----
  const cleanDomain = stripDomain(l.domain ?? l.url ?? '')
  const source = l.result_type === 'PPC' ? 'PPC' : 'SEO'
  const today = new Date().toISOString().slice(0, 10)

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
    date: { date: today },
    text1: sanitize(l.url ?? ''),
    project_owner: {
      personsAndTeams: [{ id: DEFAULT_OWNER_ID, kind: 'person' }],
    },
  }

  let createdItemId: string
  try {
    const data = await mondayGQL<{
      create_item: { id: string }
    }>(
      `mutation ($board_id: ID!, $item_name: String!, $cv: JSON!) {
        create_item(board_id: $board_id, item_name: $item_name, column_values: $cv) {
          id
        }
      }`,
      {
        board_id: LEADS_BOARD_ID,
        item_name: cleanDomain || `lead-${leadId}`,
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
  if (l.screenshot_content_link) {
    try {
      const { data: blob, error: dlErr } = await svc.storage
        .from('lead-screenshots')
        .download(l.screenshot_content_link)
      if (!dlErr && blob) {
        await uploadFileToMondayColumn(createdItemId, 'files', blob, fileNameFor(l))
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
  await svc
    .from('google_lead_gen_table')
    .update({
      pushed_to_monday_at: new Date().toISOString(),
      monday_pushed_item_id: createdItemId,
      monday_pushed_by: opts?.pushedBy ?? null,
    })
    .eq('id', leadId)

  return {
    ok: true,
    monday_item_id: createdItemId,
    attached_file: attachedFile,
    s_tag_update_posted: sTagUpdatePosted,
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
