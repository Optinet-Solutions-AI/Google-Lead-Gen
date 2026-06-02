import type { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
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
 *      Echo the challenge back with 200.
 *
 *   2. Event delivery.
 *      Body:  { "event": { "type": "...", "boardId": ..., ... } }
 *
 * Authentication — webhooks created via Monday's `create_webhook` API
 * (what scripts/monday/register-webhooks.ts uses) do NOT carry a signed
 * JWT in the Authorization header, so we authenticate with a shared
 * secret carried in the URL query string (`?token=<MONDAY_WEBHOOK_TOKEN>`).
 * The registered URL is stored privately in Monday and never exposed, so
 * the token acts as a bearer secret. We still accept a valid signed JWT as
 * an alternative, so app-context webhooks (which DO sign) keep working.
 *
 * Always return 200 for ignored/unrecognized events so Monday doesn't
 * spam retries for things we deliberately skip.
 */
export async function POST(request: NextRequest): Promise<Response> {
  // Authenticate BEFORE parsing the body so we never run JSON parsing on
  // unauthenticated, attacker-controlled input.
  const authed = await isAuthenticated(request)
  if (!authed) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }

  // Challenge handshake — echo back the random. Monday sends this to the
  // exact registered URL (including ?token=), so it passes auth above.
  if (
    typeof body === 'object' &&
    body !== null &&
    'challenge' in body &&
    typeof (body as { challenge: unknown }).challenge === 'string'
  ) {
    return Response.json({ challenge: (body as { challenge: string }).challenge })
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

  // Wrap the handler so a thrown error (e.g. a Monday API hiccup while
  // re-fetching the item) becomes a controlled 500 instead of an uncaught
  // crash — both would make Monday retry, but this keeps our logs clean
  // and our reply shape consistent.
  let result: Awaited<ReturnType<typeof handleEvent>>
  try {
    result = await handleEvent(event as Parameters<typeof handleEvent>[0])
  } catch (err) {
    console.error('[monday-webhook] handler threw', err)
    return Response.json(
      { status: 'error', message: 'handler error', event_type: event.type },
      { status: 500 },
    )
  }

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

/**
 * A request is authentic if EITHER:
 *   - the `?token=` query param matches MONDAY_WEBHOOK_TOKEN (primary path,
 *     used by our create_webhook-registered webhooks), OR
 *   - the Authorization header is a valid Monday-signed JWT (kept for any
 *     future app-context webhooks that sign their deliveries).
 */
async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const expectedToken = process.env.MONDAY_WEBHOOK_TOKEN
  const providedToken = new URL(request.url).searchParams.get('token')
  if (expectedToken && providedToken && safeEqual(providedToken, expectedToken)) {
    return true
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader) {
    try {
      await verifyMondayWebhook(authHeader)
      return true
    } catch {
      return false
    }
  }

  return false
}

/** Constant-time string comparison to avoid leaking the token via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
