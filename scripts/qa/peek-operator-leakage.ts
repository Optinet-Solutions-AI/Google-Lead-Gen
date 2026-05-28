/**
 * One-off: gauge how much "operator noise" appears in recent scrape results.
 *
 * Darren flagged batch 736 (online casino New Zealand) for surfacing
 * operator sites (wildz, spinpalace, royalpanda, casumo, luckynuggetcasino)
 * instead of affiliates. This script quantifies the pattern across the
 * last N completed batches, so we can decide whether default-hiding
 * non-affiliates in the UI removes most of the visible clutter.
 *
 * Read-only. Run: npx tsx scripts/qa/peek-operator-leakage.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

const RECENT_BATCH_LIMIT = 15

type Lead = {
  batch_id: number | null
  domain: string | null
  is_affiliate: boolean | null
  is_rooster_partner: boolean | null
  is_on_monday: boolean | null
  affiliate_checked_at: string | null
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Pull most-recent N batches
  const { data: batchRows, error: bErr } = await svc
    .from('google_lead_gen_table')
    .select('batch_id, created_at')
    .not('batch_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5000)

  if (bErr) throw bErr
  const seen = new Set<number>()
  const orderedBatches: number[] = []
  for (const r of (batchRows ?? []) as Array<{ batch_id: number }>) {
    const b = r.batch_id
    if (!seen.has(b)) {
      seen.add(b)
      orderedBatches.push(b)
      if (orderedBatches.length >= RECENT_BATCH_LIMIT) break
    }
  }
  console.log(`Inspecting last ${orderedBatches.length} batches: ${orderedBatches.join(', ')}\n`)

  // Pull all leads in those batches
  const { data: leadsData, error: lErr } = await svc
    .from('google_lead_gen_table')
    .select('batch_id, domain, is_affiliate, is_rooster_partner, is_on_monday, affiliate_checked_at')
    .in('batch_id', orderedBatches)

  if (lErr) throw lErr
  const leads = (leadsData ?? []) as Lead[]
  console.log(`Total rows across these batches: ${leads.length}\n`)

  // Per-batch breakdown: total / affiliate=true / affiliate=false / affiliate=null
  const headers = ['batch', 'rows', 'affY', 'affN', 'affNull', '%aff', 'unchecked%']
  console.log(headers.map(h => h.padStart(10)).join(' '))
  for (const b of orderedBatches) {
    const rows = leads.filter(l => l.batch_id === b)
    const affY = rows.filter(l => l.is_affiliate === true).length
    const affN = rows.filter(l => l.is_affiliate === false).length
    const affNull = rows.filter(l => l.is_affiliate === null).length
    const checked = rows.filter(l => l.affiliate_checked_at != null).length
    const pctAff = rows.length ? ((affY / rows.length) * 100).toFixed(0) : '-'
    const pctUnchecked = rows.length
      ? (((rows.length - checked) / rows.length) * 100).toFixed(0)
      : '-'
    console.log(
      [String(b), String(rows.length), String(affY), String(affN), String(affNull), `${pctAff}%`, `${pctUnchecked}%`]
        .map(x => x.padStart(10))
        .join(' '),
    )
  }

  // Aggregate: what would default-hiding (is_affiliate != true) remove?
  const totalRows = leads.length
  const wouldHide = leads.filter(l => l.is_affiliate !== true).length
  const wouldShow = totalRows - wouldHide
  console.log(
    `\nIf UI default-filters to is_affiliate=true:\n` +
      `  shown:  ${wouldShow} / ${totalRows} (${((wouldShow / totalRows) * 100).toFixed(0)}%)\n` +
      `  hidden: ${wouldHide} / ${totalRows} (${((wouldHide / totalRows) * 100).toFixed(0)}%)`,
  )

  // Top non-affiliate domains (proxy for "operators slipping through")
  const nonAffDomains: Record<string, number> = {}
  for (const l of leads) {
    if (l.is_affiliate === false && l.domain) {
      nonAffDomains[l.domain] = (nonAffDomains[l.domain] ?? 0) + 1
    }
  }
  const topNonAff = Object.entries(nonAffDomains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
  console.log(`\nTop 25 non-affiliate domains (most likely operators / brand sites):`)
  for (const [d, n] of topNonAff) console.log(`  ${String(n).padStart(4)}  ${d}`)

  // Also: misclassified affiliates? Spot-check by counting affiliate=true on
  // suspiciously brand-shaped domains (casumo/wildz/etc.)
  const knownOperatorTokens = [
    'casumo',
    'wildz',
    'spinpalace',
    'royalpanda',
    'luckynugget',
    'skycitycasino',
    'leovegas',
    '888casino',
    'mrgreen',
    'betway',
    'bet365',
    'pokerstars',
    'unibet',
  ]
  const suspectAff = leads.filter(
    l =>
      l.is_affiliate === true &&
      l.domain &&
      knownOperatorTokens.some(t => l.domain!.toLowerCase().includes(t)),
  )
  if (suspectAff.length) {
    console.log(`\n⚠ ${suspectAff.length} rows classified is_affiliate=true but look like operator brands:`)
    const grouped: Record<string, number> = {}
    for (const l of suspectAff) grouped[l.domain!] = (grouped[l.domain!] ?? 0) + 1
    for (const [d, n] of Object.entries(grouped).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${d}`)
    }
  } else {
    console.log(`\nNo obvious operator-brand domains misclassified as is_affiliate=true.`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
