import type { NextRequest } from 'next/server'
import { runMondaySync } from '@/lib/monday/sync-runner'
import { BOARDS, type BoardKey } from '@/lib/monday/board-registry'
import { requireBearer } from '@/lib/auth/bearer'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Vercel cron sends GET — alias to the same handler as manual POSTs.
export async function GET(request: NextRequest) {
  return POST(request)
}

/**
 * Re-sync Monday boards into the Supabase replica. Safety net for missed
 * webhooks. Triggered by Vercel cron (see vercel.json) once per board per
 * night, staggered 10 minutes apart so each board gets its own 300s budget.
 *
 * Query: `?board=<key>` syncs a single board (one of the BoardKey values).
 * Omit the param for a full all-boards sync — used for manual catch-ups.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` if CRON_SECRET is
 * configured (Vercel cron sends this automatically).
 */
export async function POST(request: NextRequest) {
  const check = requireBearer(
    request.headers.get('authorization'),
    process.env.CRON_SECRET,
    { secretName: 'CRON_SECRET' },
  )
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })

  const boardParam = request.nextUrl.searchParams.get('board')
  let boardKey: BoardKey | undefined
  if (boardParam) {
    const match = BOARDS.find(b => b.key === boardParam)
    if (!match) {
      return Response.json(
        { error: `unknown board "${boardParam}"; expected one of ${BOARDS.map(b => b.key).join(', ')}` },
        { status: 400 },
      )
    }
    boardKey = match.key
  }

  const result = await runMondaySync(boardKey ? { boardKey } : undefined)

  return Response.json(
    {
      ok: result.ok,
      ms: result.ms,
      results: result.results,
    },
    { status: result.ok ? 200 : 500 },
  )
}
