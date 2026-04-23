/**
 * Verifies the Monday.com webhook signature.
 *
 * Monday signs every webhook request with a JWT in the `Authorization`
 * header (no `Bearer` prefix). The JWT is HS256-signed using the app's
 * signing secret. We decode + verify, and reject if the signature is
 * invalid or the `sub` claim doesn't match our MONDAY_APP_ID.
 *
 * Monday's initial verification request during `create_webhook` does
 * NOT include a signature — that's a separate challenge handshake
 * handled in the route (see app/api/monday/webhook/route.ts).
 */

import { jwtVerify, type JWTPayload } from 'jose'

export type MondayWebhookClaims = JWTPayload & {
  /** Monday app ID as a string, e.g. "10876263" */
  sub?: string
  /** Trigger data payload provided by Monday */
  dat?: Record<string, unknown>
  /** Timestamp claims */
  iat?: number
  exp?: number
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookVerificationError'
  }
}

export async function verifyMondayWebhook(
  authorizationHeader: string | null,
): Promise<MondayWebhookClaims> {
  if (!authorizationHeader) {
    throw new WebhookVerificationError('missing Authorization header')
  }

  const signingSecret = process.env.MONDAY_SIGNING_SECRET
  if (!signingSecret) {
    throw new WebhookVerificationError('MONDAY_SIGNING_SECRET is not set')
  }

  const secret = new TextEncoder().encode(signingSecret)
  // Strip optional "Bearer " prefix just in case Monday ever adds it.
  const token = authorizationHeader.replace(/^Bearer\s+/i, '').trim()

  let payload: MondayWebhookClaims
  try {
    const verified = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    payload = verified.payload as MondayWebhookClaims
  } catch (err) {
    throw new WebhookVerificationError(
      `JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Optional: pin to our app ID. Skip silently if MONDAY_APP_ID is unset
  // (useful for local-only testing scenarios).
  const expectedAppId = process.env.MONDAY_APP_ID
  if (expectedAppId && payload.sub && String(payload.sub) !== expectedAppId) {
    throw new WebhookVerificationError(
      `app_id mismatch: expected ${expectedAppId}, got ${payload.sub}`,
    )
  }

  return payload
}
