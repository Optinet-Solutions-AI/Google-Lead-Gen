import type { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireBearer } from '@/lib/auth/bearer'
import { runAiAnalysis } from '@/lib/ai-analysis/run'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Vercel cron sends GET — alias to the same handler as manual POSTs.
export async function GET(request: NextRequest) {
  return POST(request)
}

/**
 * Run the AI website-analysis stage over websites that survived the trim
 * (not already on Monday, not marked not-relevant, no system flag).
 *
 * Stages: triage (cheap screen) → audit (we fetch, the model judges) →
 * CTA extraction + redirect unmasking (code, no model) → hand the confirmed
 * affiliates to the VM's browser S-tag queue.
 *
 * It is a no-op unless `ai_analysis_enabled` is true and an OpenAI key is
 * configured, and it stops at the `ai_crawl_daily_cap` and
 * `ai_crawl_budget_usd` ceilings.
 *
 * Query:
 *   ?country=NO      only this country's recent jobs
 *   ?jobs=<uuid,..>  specific scrape jobs
 *   ?days=14         how far back to look for completed jobs
 *   ?triage=50       max sites to screen this run
 *   ?audit=25        max sites to open this run
 *   ?budget=5        dollar ceiling for this run
 *   ?dry=1           rehearse, write nothing
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
 */
export async function POST(request: NextRequest) {
  const check = requireBearer(
    request.headers.get('authorization'),
    process.env.CRON_SECRET,
    { secretName: 'CRON_SECRET' },
  )
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })

  const sp = request.nextUrl.searchParams
  const num = (key: string, fallback: number, max: number): number => {
    const n = Number(sp.get(key))
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback
  }
  const country = sp.get('country')?.trim().toUpperCase()
  const jobs = sp.get('jobs')?.split(',').map(s => s.trim()).filter(Boolean)
  const dry = sp.get('dry') === '1'

  const progress: string[] = []
  const result = await runAiAnalysis(createServiceClient(), {
    ...(jobs && jobs.length > 0 ? { jobIds: jobs } : {}),
    ...(country ? { countryCode: country } : {}),
    days: num('days', 14, 90),
    triageLimit: num('triage', 50, 300),
    auditLimit: num('audit', 25, 150),
    budgetUsd: num('budget', 5, 50),
    dryRun: dry,
    onProgress: msg => { if (progress.length < 200) progress.push(msg) },
  })

  return Response.json({ ...result, progress })
}
