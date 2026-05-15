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
  // Branch on the Authorization header BEFORE parsing the body — Monday's
  // setup-time challenge handshake is the only unsigned request and is
  // recognised by the missing Authorization. Event deliveries get
  // verified up-front so we never run JSON parsing on attacker-controlled
  // bodies before checking authenticity.
  const authHeader = request.headers.get('authorization')

  if (!authHeader) {
    // Challenge handshake — read body and echo back the random.
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 })
    }
    if (
      typeof body === 'object' &&
      body !== null &&
      'challenge' in body &&
      typeof (body as { challenge: unknown }).challenge === 'string'
    ) {
      return Response.json({ challenge: (body as { challenge: string }).challenge })
    }
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Event delivery — verify the JWT FIRST, before touching the body.
  try {
    await verifyMondayWebhook(authHeader)
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'unauthorized' },
      { status: 401 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
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
    // Log full details server-side; reply to Monday with a generic
    // shape so Supabase error text doesn't surface in their UI/logs.
    console.error('[monday-webhook]', result)
    return Response.json(
      { status: 'error', event_type: result.event_type, board: result.board },
      { status: 500 },
    )
  }

  return Response.json(result, { status: 200 })
}
