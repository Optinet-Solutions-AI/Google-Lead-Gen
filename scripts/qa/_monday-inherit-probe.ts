/**
 * LGP-233/234 — Monday inheritance probe: coverage lift + cost/time saved.
 *
 * Reports how many leads were populated from matched Monday items (contacts,
 * s-tags, classification) and estimates the enrichment work avoided — each
 * inherited lead would otherwise have run up to 4 enrichment fetch jobs
 * (contact, affiliate, rooster, s-tag), every one a proxy-routed browser
 * fetch that costs bandwidth + minutes + (sometimes) a captcha solve.
 *
 *   npx tsx scripts/qa/_monday-inherit-probe.ts
 */
import { config } from 'dotenv'; config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const G = 'google_lead_gen_table'
const c = async (q: unknown) => (await (q as Promise<{ count: number | null }>)).count ?? 0
const head = { count: 'exact' as const, head: true }

;(async () => {
  const inherited = await c(s.from(G).select('id', head).not('monday_inherited_at', 'is', null))
  const affMonday = await c(s.from(G).select('id', head).eq('affiliate_source', 'monday'))
  const roosterMonday = await c(s.from(G).select('id', head).eq('rooster_source', 'monday'))
  const contactMonday = await c(s.from('contact_table').select('lead_id', head).eq('source', 'monday'))
  const stagsMonday = await c(s.from('s_tags_table').select('id', head).eq('origin', 'monday'))
  const onMondayLeft = await c(s.from(G).select('id', head).eq('is_on_monday', true).is('monday_inherited_at', null))

  // Enrichment jobs avoided: an inherited lead skips the stages Monday
  // satisfied. Conservative = 1/lead (it's on Monday so it was skipped
  // anyway); realistic = the stages we filled (contact + class + s-tag).
  const jobsAvoidedConservative = inherited
  const jobsAvoidedRealistic = contactMonday + affMonday + roosterMonday + Math.min(stagsMonday, inherited)

  console.log('======== MONDAY INHERITANCE — LIFT + SAVINGS ========')
  console.log(`leads inherited from Monday:      ${inherited.toLocaleString()}`)
  console.log(`  is_affiliate set via Monday:    ${affMonday.toLocaleString()}`)
  console.log(`  is_rooster_partner via Monday:  ${roosterMonday.toLocaleString()}`)
  console.log(`  contact rows source=monday:     ${contactMonday.toLocaleString()}`)
  console.log(`  s-tags origin=monday:           ${stagsMonday.toLocaleString()}`)
  console.log(`  on-Monday still un-inherited:   ${onMondayLeft.toLocaleString()} (cron picks these up)`)
  console.log('')
  console.log('--- enrichment work avoided (cost/time saved) ---')
  console.log(`  data points inherited (no scrape): ${(contactMonday + affMonday + roosterMonday + stagsMonday).toLocaleString()}`)
  console.log(`  enrichment fetch-jobs avoided:     ~${jobsAvoidedRealistic.toLocaleString()} (realistic) / ${jobsAvoidedConservative.toLocaleString()} (leads)`)
  console.log(`  each avoided fetch = 1 proxy-routed browser load (bandwidth + ~30-90s + possible captcha).`)
})().catch(e => { console.error(e); process.exit(1) })
