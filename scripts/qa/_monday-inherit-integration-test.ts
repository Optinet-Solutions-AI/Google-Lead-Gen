/**
 * LGP-235/236/237 — Monday inheritance integration tests (DB-level).
 * Read-mostly: the only write is re-running inherit on an already-inherited
 * lead (idempotent by design), which must NOT change anything.
 *   npx tsx scripts/qa/_monday-inherit-integration-test.ts
 */
import { config } from 'dotenv'; config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

;(async () => {
  // Pick a FULL-inheritance lead: one that got Monday s-tags (affiliates
  // board w/ brand columns) AND a Monday contact — the rich case that
  // exercises every signal. (Contacts-only 'leads'-board items legitimately
  // have no s-tags/affiliate, so they'd fail the strict assertions below.)
  const { data: stagLead } = await s
    .from('s_tags_table').select('lead_id').eq('origin', 'monday').limit(1).maybeSingle()
  const leadId = (stagLead as { lead_id: number } | null)?.lead_id
  check('found a full-inheritance lead to test', !!leadId, String(leadId))
  if (!leadId) { finish(); return }

  // E2E snapshot (LGP-237): the lead + contact + s-tags carry Monday labels.
  const { data: lead } = await s.from('google_lead_gen_table')
    .select('is_on_monday, affiliate_source, rooster_source, monday_inherited_at, has_contact_details, has_s_tags')
    .eq('id', leadId).single()
  const L = lead as Record<string, unknown>
  check('lead is on Monday', L.is_on_monday === true)
  check('monday_inherited_at stamped', !!L.monday_inherited_at)
  check('affiliate_source = monday', L.affiliate_source === 'monday')

  const { data: contact } = await s.from('contact_table')
    .select('source, items').eq('lead_id', leadId).maybeSingle()
  const C = contact as { source: string; items: Array<{ method?: string }> | null }
  check('contact source = monday', C.source === 'monday')
  check('contact items method = monday', Array.isArray(C.items) && C.items.every(i => i.method === 'monday'))
  check('has_contact_details true (skip gate sees it)', L.has_contact_details === true)

  const { data: stags } = await s.from('s_tags_table').select('id, origin').eq('lead_id', leadId)
  const S = (stags ?? []) as Array<{ origin: string }>
  const stagCountBefore = S.length
  const mondayStags = S.filter(t => t.origin === 'monday').length
  check('s-tags present + origin=monday', stagCountBefore > 0 && mondayStags === stagCountBefore, `${mondayStags}/${stagCountBefore}`)
  check('has_s_tags true', L.has_s_tags === true)

  // Idempotency (LGP-235): re-running inherit must not duplicate anything.
  await s.rpc('inherit_monday_data_for_lead', { p_lead_id: leadId })
  const { count: stagAfter } = await s.from('s_tags_table').select('id', { count: 'exact', head: true }).eq('lead_id', leadId)
  check('idempotent: s-tag count unchanged after re-run', (stagAfter ?? -1) === stagCountBefore, `${stagAfter} vs ${stagCountBefore}`)
  const { count: contactRows } = await s.from('contact_table').select('lead_id', { count: 'exact', head: true }).eq('lead_id', leadId)
  check('idempotent: single contact row (no dupes)', (contactRows ?? 0) === 1, String(contactRows))

  // force_enrich precedence (LGP-236) — structural: the RPC + column exist so
  // an operator can override the Monday skip and re-extract fresh (verified
  // non-destructively; we don't flip a live lead here).
  const { error: feErr } = await s.rpc('force_enrich_leads', { p_lead_ids: [] })
  check('force_enrich_leads RPC callable (override path exists)', !feErr, feErr?.message)

  finish()
})().catch(e => { console.error(e); process.exit(1) })

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) { console.error('\nFAILURES:\n  ' + fails.join('\n  ')); process.exit(1) }
  console.log('All Monday-inheritance integration assertions passed ✅')
}
