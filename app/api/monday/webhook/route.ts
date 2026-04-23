import type { NextRequest } from 'next/server'
import { verifyMondayWebhook } from '@/lib/monday/webhook-verify'
import { handleEvent } from '@/lib/monday/event-handlers'

/**
 * POST /api/monday/webhook
 *
 * Receives Monday.com webhook events and mirrors the change to Supabase.
 *
 * Two kinds of incoming request:
 *
 *   1. Challenge handshake (only during `create_webhook` setup).
 *      Body:  { "challenge": "<random>" }
 *      No Authorization header.
 *      Echo the challenge back with 200.
 *
 *   2. Event delivery.
 *      Body:  { "event": { "type": "...", "boardId": ..., ... } }
 *      Authorization header contains an HS256 JWT signed with
 *      MONDAY_SIGNING_SECRET. Verify, then dispatch.
 *
 * Always return 200 for ignored/unrecognized events so Monday doesn't
 * spam retries for things we deliberately skip.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }

  // 1. Challenge handshake — no signature required, just echo back.
  if (
    typeof body === 'object' &&
    body !== null &&
    'challenge' in body &&
    typeof (body as { challenge: unknown }).challenge === 'string'
  ) {
    return Response.json({ challenge: (body as { challenge: string }).challenge })
  }

  // 2. Event delivery — verify signature first.
  try {
    await verifyMondayWebhook(request.headers.get('authorization'))
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'unauthorized' },
      { status: 401 },
    )
  }

  // Extract the event payload.
  const event =
    typeof body === 'object' &&
    body !== null &&
    'event' in body &&
    typeof (body as { event: unknown }).event === 'object'
      ? (body as { event: Record<string, unknown> }).event
      : null

  if (!event || typeof event.type !== 'string') {
    return Response.json({ error: 'missing event.type' }, { status: 400 })
  }

  const result = await handleEvent(event as Parameters<typeof handleEvent>[0])

  if (result.status === 'error') {
    console.error('[monday-webhook]', result)
    return Response.json(result, { status: 500 })
  }

  return Response.json(result, { status: 200 })
}
