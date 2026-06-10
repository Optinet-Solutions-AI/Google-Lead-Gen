/**
 * Dry-run preview for the job-level "Push to Monday" feature.
 *
 * Prints exactly which results a given scrape job WOULD push to the Rooster
 * Leads board — without creating a single Monday item. Use this to sanity
 * check the per-engine mapping (name / brand / funnel link / email / s-tags)
 * before clicking the real "Push leads to Monday" button in the UI.
 *
 * Mirrors the candidate predicate + column mapping in lib/monday/push-job.ts
 * and lib/monday/push-entity.ts. Those import `server-only`, so they can't be
 * pulled into a plain tsx script — we re-derive the read-only preview here
 * from the same client-safe ENGINE_CONFIGS registry.
 *
 * Run locally (PowerShell on your laptop):
 *   npx tsx scripts/qa/dry-push-job.ts <job-uuid>
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { ENGINE_CONFIGS, isSocialEngine } from '../../lib/monday/engine-config'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const jobId = process.argv[2]
  if (!jobId) throw new Error('Usage: npx tsx scripts/qa/dry-push-job.ts <job-uuid>')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: jobData, error: jobErr } = await svc
    .from('scrape_queue')
    .select('id, keyword, country_code, search_engine, status')
    .eq('id', jobId)
    .maybeSingle()
  if (jobErr) throw jobErr
  if (!jobData) throw new Error(`Job ${jobId} not found.`)
  const job = jobData as {
    id: string
    keyword: string | null
    country_code: string | null
    search_engine: string | null
    status: string
  }

  console.log('='.repeat(70))
  console.log(`Job      ${job.id}`)
  console.log(`Keyword  ${job.keyword ?? '—'}`)
  console.log(`Country  ${job.country_code ?? '—'}`)
  console.log(`Engine   ${job.search_engine ?? '(google)'}`)
  console.log(`Status   ${job.status}`)
  console.log('='.repeat(70))

  if (isSocialEngine(job.search_engine)) {
    await previewSocial(svc, job)
  } else {
    await previewLeads(svc, job)
  }
}

async function previewLeads(
  svc: ReturnType<typeof createClient>,
  job: { id: string },
) {
  const { data, error } = await svc
    .from('google_lead_gen_table')
    .select('id, domain, url, brand, pushed_to_monday_at')
    .eq('scrape_job_id', job.id)
    .eq('has_s_tags', true)
    .eq('is_not_relevant', false)
  if (error) throw error
  const rows = (data ?? []) as unknown as Array<{
    id: number
    domain: string | null
    url: string | null
    brand: string | null
    pushed_to_monday_at: string | null
  }>
  const fresh = rows.filter(r => !r.pushed_to_monday_at)
  const already = rows.length - fresh.length
  console.log(`\nGoogle/Bing leads path — s-tagged, relevant leads`)
  console.log(`Candidates: ${rows.length}  |  would push: ${fresh.length}  |  already on Monday: ${already}\n`)
  for (const r of fresh) {
    console.log(`  • [${r.id}] name=${r.domain || r.url || `lead-${r.id}`}  brand=${r.brand ?? '—'}`)
  }
  if (fresh.length === 0) console.log('  (nothing to push)')
}

async function previewSocial(
  svc: ReturnType<typeof createClient>,
  job: { id: string; keyword: string | null; search_engine: string | null },
) {
  const engine = job.search_engine as keyof typeof ENGINE_CONFIGS
  const cfg = ENGINE_CONFIGS[engine]

  const cols = new Set<string>([
    'id',
    'is_likely_affiliate',
    'pushed_to_monday_at',
    'discovered_from_keyword',
    ...cfg.nameCols,
    cfg.profileUrlCol,
  ])
  if (cfg.emailCol) cols.add(cfg.emailCol)
  if (cfg.bioLinkCol) cols.add(cfg.bioLinkCol)
  if (cfg.hasNotRelevant) cols.add('is_not_relevant')

  const { data, error } = await svc
    .from(cfg.table)
    .select(Array.from(cols).join(', '))
    .eq('scrape_queue_id', job.id)
  if (error) throw error
  const rows = (data ?? []) as unknown as Array<Record<string, unknown> & { id: string }>

  const candidates = rows.filter(r => {
    if (r.is_likely_affiliate !== true) return false
    if (cfg.hasNotRelevant && r.is_not_relevant === true) return false
    return true
  })
  const fresh = candidates.filter(r => r.pushed_to_monday_at == null)
  const already = candidates.length - fresh.length

  console.log(`\n${cfg.sourceLabel} entities path — likely affiliates (${cfg.table})`)
  console.log(`Total rows: ${rows.length}  |  candidates: ${candidates.length}  |  would push: ${fresh.length}  |  already on Monday: ${already}\n`)

  const str = (r: Record<string, unknown>, c: string | null) =>
    c && typeof r[c] === 'string' ? (r[c] as string) : ''

  for (const r of fresh) {
    const linkCols = ['resolved_url', 'url', cfg.linkBrandCol]
    if (cfg.linkHasStag) linkCols.push('s_tag')
    const { data: links } = await svc
      .from(cfg.linksTable)
      .select(linkCols.join(', '))
      .eq(cfg.linksFk, r.id)
    const ls = (links ?? []) as unknown as Array<Record<string, unknown>>
    const firstFunnel = ls.find(l => l.resolved_url || l.url)
    const funnel = firstFunnel ? String(firstFunnel.resolved_url || firstFunnel.url) : ''
    const brand = ls.map(l => str(l, cfg.linkBrandCol)).find(Boolean) ?? ''
    const website = funnel || str(r, cfg.bioLinkCol) || str(r, cfg.profileUrlCol)
    const name = cfg.nameCols.map(c => str(r, c)).find(Boolean) || `${engine}-${r.id}`
    const sTags = cfg.linkHasStag ? ls.filter(l => str(l, 's_tag') && str(l, cfg.linkBrandCol)).length : 0
    console.log(`  • ${name}`)
    console.log(`      brand=${brand || '—'}  email=${str(r, cfg.emailCol) || '—'}  s-tags=${sTags}`)
    console.log(`      website=${website || '—'}`)
  }
  if (fresh.length === 0) console.log('  (nothing to push)')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
