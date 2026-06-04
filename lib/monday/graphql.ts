/**
 * Monday.com GraphQL client usable from both Next.js API routes and
 * Node scripts. Reads MONDAY_API_URL and MONDAY_API_TOKEN from env.
 *
 * Retries on HTTP 429 using the Retry-After header.
 */

const DEFAULT_API_URL = 'https://api.monday.com/v2'
const API_VERSION = '2025-07'

export type MondayErrorShape = {
  message: string
  extensions?: Record<string, unknown>
}

export class MondayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'MondayApiError'
  }
}

export async function mondayGQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  attempt = 0,
): Promise<T> {
  const url = process.env.MONDAY_API_URL ?? DEFAULT_API_URL
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN is not set in the environment')

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'API-Version': API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (res.status === 429 && attempt < 5) {
    // Retry-After is a delay in seconds OR an HTTP-date (RFC 7231). For the
    // date form Number(...) is NaN, which would make setTimeout fire
    // immediately and hot-loop the retry up to 5× — fall back to 10s.
    const parsed = Number(res.headers.get('retry-after'))
    const waitSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : 10
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000))
    return mondayGQL<T>(query, variables, attempt + 1)
  }

  if (!res.ok) {
    throw new MondayApiError(
      `Monday API HTTP ${res.status}`,
      res.status,
      await res.text(),
    )
  }

  const body = (await res.json()) as {
    data?: T
    errors?: MondayErrorShape[]
    error_code?: string
    error_message?: string
  }

  if (body.error_code) {
    throw new MondayApiError(
      `Monday API error ${body.error_code}: ${body.error_message ?? ''}`,
      res.status,
      body,
    )
  }
  if (body.errors?.length) {
    throw new MondayApiError(
      `Monday GraphQL errors: ${body.errors.map(e => e.message).join('; ')}`,
      res.status,
      body,
    )
  }
  if (body.data == null) {
    throw new MondayApiError('Monday API returned no data', res.status, body)
  }
  return body.data
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Common query fragments
// ---------------------------------------------------------------------------

/** Fields we fetch for every item (same shape used by sync + webhooks). */
export const ITEM_FIELDS = `
  id
  name
  created_at
  updated_at
  group { id title }
  column_values { id type text value }
  subitems { id }
`

export const UPDATE_FIELDS = `
  id
  body
  text_body
  created_at
  creator { id name email }
`
