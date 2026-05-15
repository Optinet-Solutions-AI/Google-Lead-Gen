import { createHash, timingSafeEqual } from 'node:crypto'

export type BearerCheck = { ok: true } | { ok: false; status: number; error: string }

/**
 * Verify an `Authorization: Bearer <token>` header against a secret
 * read from env. Fails closed (500) when the secret is unset/empty so
 * a misconfigured deployment can't accidentally accept anonymous
 * traffic. Uses a hash-then-`timingSafeEqual` compare so attackers
 * can't time-oracle the token byte-by-byte.
 */
export function requireBearer(
  authHeader: string | null | undefined,
  secret: string | undefined,
  opts: { secretName: string },
): BearerCheck {
  if (!secret) {
    return {
      ok: false,
      status: 500,
      error: `Server misconfigured: ${opts.secretName} is not set.`,
    }
  }
  const provided = authHeader ?? ''
  // Hash both sides to fixed length — timingSafeEqual would otherwise
  // throw on length mismatch and the length itself would leak.
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }
  return { ok: true }
}
