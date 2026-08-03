/**
 * LGP-218 — tests for the Monday inheritance normalizers.
 *   npx tsx scripts/qa/_monday-inherit-test.ts
 */
import {
  normalizeMondayContacts,
  normalizeMondayStags,
  classifyFromMonday,
  type MondayItem,
} from '../../lib/monday/inherit'

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// Real-shaped affiliate item (from get_monday_item_for_lead).
const aff: MondayItem = {
  _board: 'affiliates',
  monday_item_id: '1258521579',
  email: 'CrazyVegas@CrazyVegas.com',
  website: 'https://au.crazyvegas.com/',
  affiliate_name: 'Crazy Vegas',
  l7_sj_rs_lv_ro: '157307,\t170530, 170531',
  rb_fp_su: '164241',
  pm: '',
  nd: '',
}

// --- contacts ---
{
  const items = normalizeMondayContacts(aff)
  check('email inherited + lowercased', items.some(i => i.kind === 'email' && i.value === 'crazyvegas@crazyvegas.com'))
  check('email method = monday', items.find(i => i.kind === 'email')?.method === 'monday')
  check('email labeled monday.com', items.find(i => i.kind === 'email')?.label === 'monday.com')
  check('website inherited as contact_link', items.some(i => i.kind === 'contact_link' && i.value === 'https://au.crazyvegas.com/'))
  const noEmail = normalizeMondayContacts({ _board: 'affiliates', website: 'https://x.com/' })
  check('missing email → no email item', !noEmail.some(i => i.kind === 'email'))
  const badEmail = normalizeMondayContacts({ _board: 'affiliates', email: 'not-an-email' })
  check('invalid email rejected', !badEmail.some(i => i.kind === 'email'))
}

// --- s-tags ---
{
  const tags = normalizeMondayStags(aff)
  check('tracking ids split into s-tags', tags.length >= 4, `${tags.length}`)
  check('s-tag 157307 present', tags.some(t => t.s_tag === '157307'))
  check('l7 family labeled + rooster', tags.some(t => t.s_tag === '157307' && t.is_rooster_brand && (t.brand ?? '').includes('Lucky7Even')))
  check('rb single-brand labeled Rooster.bet family', tags.some(t => t.s_tag === '164241' && (t.brand ?? '').includes('Rooster.bet')))
  check('all s-tags origin = monday', tags.every(t => t.origin === 'monday'))
  const affId = normalizeMondayStags({ _board: 'not_relevant_leads', affiliate_id: '99001, 99002' })
  check('affiliate_id column → s-tags (non-rooster)', affId.length === 2 && affId.every(t => !t.is_rooster_brand))
}

// --- classification ---
{
  const c = classifyFromMonday(aff)
  check('affiliates board ⇒ is_affiliate true', c.is_affiliate === true)
  check('populated brand column ⇒ rooster partner', c.is_rooster_partner === true)
  check('brand resolved', !!c.brand)
  check('matched brand columns recorded', c.matchedBrandColumns.includes('l7_sj_rs_lv_ro') && c.matchedBrandColumns.includes('rb_fp_su'))

  const leadsBoard = classifyFromMonday({ _board: 'leads', website: 'https://x.com/' }, 'leads')
  check('leads board with no brand ⇒ is_affiliate null (not forced)', leadsBoard.is_affiliate === null)
  check('leads board ⇒ not rooster', leadsBoard.is_rooster_partner === false)

  const roosterViaTag = classifyFromMonday({ _board: 'leads', pm: '5001' }, 'leads')
  check('rooster tracking id on non-affiliate board still ⇒ affiliate+rooster', roosterViaTag.is_affiliate === true && roosterViaTag.is_rooster_partner === true)
  check('pm single-brand ⇒ PlayMojo', roosterViaTag.brand === 'PlayMojo')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) { console.error('\nFAILURES:\n  ' + fails.join('\n  ')); process.exit(1) }
console.log('All Monday-inheritance normalizer assertions passed ✅')
