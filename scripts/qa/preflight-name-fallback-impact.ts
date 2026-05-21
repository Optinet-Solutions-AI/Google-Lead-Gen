/**
 * Dry-run impact count for the 20260522060000_monday_name_fallback
 * backfill. Reports, *without writing anything*:
 *   - Total non-overridden leads that would be re-evaluated
 *   - How many would FLIP from is_on_monday=false → true via the new
 *     exact_name / registered_name tiers
 *   - Of those flips, how many would land on the not_relevant_leads
 *     board (i.e. would get is_not_relevant=true)
 *   - How many pending/paused enrichment jobs would be cancelled
 *
 * Uses a temporary CTE that mirrors the migration's matcher logic
 * via the *existing* search_website_on_monday RPC and the proposed
 * name-fallback joins computed inline. Read-only.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  // We can't run arbitrary SQL via the JS client, so do the impact
  // estimate as a series of focused counts.

  // 1. Title-only items per board (what the migration comment cites).
  const BOARDS = [
    'leads_table',
    'affiliates_table',
    'not_relevant_leads_table',
    'email_undelivered_leads_table',
  ] as const
  console.log('=== Title-only Monday items (name has ".", no "/", website_normalized empty) ===')
  for (const t of BOARDS) {
    const { count, error } = await svc
      .from(t)
      .select('monday_item_id', { head: true, count: 'exact' })
      .or('website_normalized.is.null,website_normalized.eq.')
      .ilike('name', '%.%')
      .not('name', 'ilike', '%/%')
    if (error) { console.warn(`  ! ${t}: ${error.message}`); continue }
    console.log(`  ${t.padEnd(38)} title-only items = ${count}`)
  }

  // 2. Total non-overridden leads that the backfill scans.
  const { count: totalNonOverridden } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .is('monday_overridden_at', null)
  console.log(`\nNon-overridden leads in scope = ${totalNonOverridden}`)

  // 3. Non-overridden leads currently is_on_monday=false — the pool
  //    from which "flips to true" can happen.
  const { count: candidates } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .is('monday_overridden_at', null)
    .eq('is_on_monday', false)
  console.log(`Currently is_on_monday=false, non-overridden = ${candidates}`)

  // 4. Pending/paused enrichment jobs in flight (upper bound on what
  //    could be cancelled — actual cancellations are the subset whose
  //    lead flips to is_not_relevant=true).
  const { count: pendingEnrich } = await svc
    .from('enrichment_fetch_queue')
    .select('lead_id', { head: true, count: 'exact' })
    .in('status', ['pending', 'paused'])
  console.log(`Pending/paused enrichment jobs (upper bound) = ${pendingEnrich}`)

  // 5. Sanity: run the *current* RPC and the *proposed* match logic on
  //    a small sample of non-overridden, is_on_monday=false leads with
  //    a domain, to estimate the flip rate.
  console.log('\n=== Sample of 200 candidates: do they match a title-only Monday item? ===')
  const { data: sample } = await svc
    .from('google_lead_gen_table')
    .select('id, domain, url, country_code')
    .is('monday_overridden_at', null)
    .eq('is_on_monday', false)
    .not('domain', 'is', null)
    .order('id', { ascending: false })
    .limit(200)

  if (!sample || sample.length === 0) {
    console.log('  (no sample)')
    return
  }

  // Use existing RPC for the canonical answer; compare to a manual
  // "is the registered domain the name of any title-only item" lookup.
  let wouldFlip = 0
  let wouldFlipNotRelevant = 0
  for (const row of sample as Array<{ id: number; domain: string | null; url: string | null }>) {
    const d = ((row.domain || row.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '').trim()
    if (!d) continue
    // Current matcher
    const { data: hits } = await svc.rpc('search_website_on_monday', { p_domain: d })
    if ((hits ?? []).length > 0) continue // already matches today; not a flip
    // Would the name fallback match?
    for (const t of BOARDS) {
      const { data: nameHit } = await svc
        .from(t)
        .select('monday_item_id, name')
        .or('website_normalized.is.null,website_normalized.eq.')
        .ilike('name', d)
        .not('name', 'ilike', '%/%')
        .limit(1)
      if ((nameHit ?? []).length > 0) {
        wouldFlip++
        if (t === 'not_relevant_leads_table') wouldFlipNotRelevant++
        break
      }
    }
  }
  console.log(`  flips in sample of ${sample.length}: ${wouldFlip}  (of which → not_relevant: ${wouldFlipNotRelevant})`)
  if (totalNonOverridden && candidates) {
    const rate = wouldFlip / sample.length
    const nrRate = wouldFlipNotRelevant / sample.length
    console.log(`  projected over ${candidates} candidates: ~${Math.round(rate * candidates)} flips, ~${Math.round(nrRate * candidates)} → not_relevant`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
