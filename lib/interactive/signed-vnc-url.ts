import 'server-only'

/**
 * Signs a short-lived noVNC URL pointing at a specific worker port
 * on the VM. The dashboard hands these to admins as one-time
 * disposable links — they expire fast enough that even if a link
 * leaks (paste in chat / screenshot) it's useless within minutes.
 *
 * VM-side nginx verifies the same HMAC before allowing the WebSocket
 * upgrade through to websockify. See docs/runbook-novnc.md for the
 * matching nginx config.
 *
 * Token format (base64url, no padding):
 *
 *   <header>.<payload>.<signature>
 *
 * Where:
 *   header    = '{"alg":"HS256","typ":"VNC1"}'  (constant)
 *   payload   = '{"port":9222,"exp":<unix-ts>,"jti":"<random>"}'
 *   signature = HMAC-SHA256(header + '.' + payload, secret)
 */

const HEADER = { alg: 'HS256', typ: 'VNC1' } as const

function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return new Uint8Array(sig)
}

export type SignedVncUrlOptions = {
  /** Chrome debugger port on the VM (9222 / 9223 / 9224). */
  workerPort: number
  /** Token TTL in seconds. Default 15 min. */
  ttlSeconds?: number
  /**
   * Per-checkpoint VM ingress host (e.g. "https://54.79.22.202.nip.io").
   * Set by the worker when it creates the checkpoint so the dashboard
   * routes the URL to the right VM in a multi-VM fleet. NULL/undefined
   * falls back to NEXT_PUBLIC_VNC_BASE_URL.
   */
  hostBase?: string | null
}

/**
 * Returns a fully-resolved URL the dashboard can hand to the operator
 * to open in a new tab. Returns null when neither hostBase nor the
 * NEXT_PUBLIC_VNC_BASE_URL env var is configured, or when
 * INTERACTIVE_VNC_HMAC_SECRET is missing.
 */
export async function buildSignedVncUrl(
  opts: SignedVncUrlOptions,
): Promise<string | null> {
  const base = opts.hostBase || process.env.NEXT_PUBLIC_VNC_BASE_URL
  const secret = process.env.INTERACTIVE_VNC_HMAC_SECRET
  if (!base || !secret) return null

  const ttl = opts.ttlSeconds ?? 15 * 60
  const exp = Math.floor(Date.now() / 1000) + ttl
  const jti = crypto.randomUUID()
  const payload = { port: opts.workerPort, exp, jti }

  const headerB64 = b64url(JSON.stringify(HEADER))
  const payloadB64 = b64url(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = await hmacSha256(secret, signingInput)
  const sigB64 = b64url(sig)
  const token = `${signingInput}.${sigB64}`

  // base = "https://vnc.lead-gen.example.com" — no trailing slash.
  // The VM's nginx routes /vnc/<port>/ to the matching websockify.
  //
  // The `path` query parameter is read by noVNC's vnc_lite.html — without
  // it the client defaults to wss://host/websockify (root path) and
  // bypasses our /vnc/<port>/ routing.
  //
  // We embed the token INSIDE the path so noVNC's WebSocket URL becomes
  // wss://host/vnc/<port>/websockify?token=<token>. noVNC otherwise
  // doesn't propagate any query string from the page URL into the WS
  // URL, so the token has to ride along inside the `path` value or the
  // nginx auth_request subrequest sees an empty `$arg_token`.
  const trimmed = base.replace(/\/+$/, '')
  const wsPath = `vnc/${opts.workerPort}/websockify?token=${token}`
  return (
    `${trimmed}/vnc/${opts.workerPort}/` +
    `?path=${encodeURIComponent(wsPath)}`
  )
}
