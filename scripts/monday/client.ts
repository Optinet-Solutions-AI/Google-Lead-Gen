/**
 * Minimal Monday.com GraphQL client for one-off server-side scripts.
 *
 * - Reads MONDAY_API_URL and MONDAY_API_TOKEN from process.env
 * - Retries on HTTP 429 using the Retry-After header
 * - Throws on GraphQL errors (no silent partial responses)
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

  // Handle rate limit with Retry-After
  if (res.status === 429 && attempt < 5) {
    const waitSeconds = Number(res.headers.get('retry-after') ?? 10)
    console.log(`[monday] 429 — waiting ${waitSeconds}s (attempt ${attempt + 1}/5)`)
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000))
    return mondayGQL<T>(query, variables, attempt + 1)
  }

  if (!res.ok) {
    const body = await res.text()
    throw new MondayApiError(
      `Monday API returned HTTP ${res.status}`,
      res.status,
      body,
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

/** Rough throttle helper — sleep between requests to stay under complexity budget. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
