import type { NextRequest } from 'next/server'
import { runMondaySync } from '@/lib/monday/sync-runner'
import { requireBearer } from '@/lib/auth/bearer'

// Allow up to 5 minutes — full re-sync of 4 boards can run several
// minutes given the 700ms inter-request throttle. Vercel Pro caps at 300s.
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Vercel cron sends GET — alias to the same handler as manual POSTs.
export async function GET(request: NextRequest) {
  return POST(request)
}

/**
 * Nightly full re-sync of every Monday board into the Supabase replica.
 * Runs as a safety net for missed webhooks. Triggered by Vercel cron
 * (see vercel.json) at 23:00 UTC daily — that's midnight CET in winter,
 * 01:00 CEST in summer.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` if CRON_SECRET is
 * configured (Vercel cron sends this automatically). For manual invocation
 * use the same header.
 */
export async function POST(request: NextRequest) {
  const check = requireBearer(
    request.headers.get('authorization'),
    process.env.CRON_SECRET,
    { secretName: 'CRON_SECRET' },
  )
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })

  const result = await runMondaySync()

  return Response.json(
    {
      ok: result.ok,
      ms: result.ms,
      results: result.results,
    },
    { status: result.ok ? 200 : 500 },
  )
}
