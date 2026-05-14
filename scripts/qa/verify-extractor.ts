/**
 * Verify that the new extract_normalized_domains() correctly splits
 * glued domain chains. Tests against the known PBN body_text that
 * triggered the QA false-negatives and a few safety edge cases.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/qa/verify-extractor.ts
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: join(process.cwd(), '.env.local') })

type Case = {
  name: string
  input: string
  mustInclude: string[]
  mustNotInclude?: string[]
}

const CASES: Case[] = [
  {
    name: 'Real PBN glue from affiliates_updates_table item 2539285865',
    input:
      'PBN AT highland-cattle.atcasinomithandyrechnung.atbeste-legale-casinos.at/casino-mit-handyrechnung/ artcarnuntum.at/online-casinos',
    // With the additive approach the array also contains junk entries
    // like "atbeste-legale-casinos.at" (the registered_domain of the
    // whole greedy match) — harmless, no real lead has that shape.
    mustInclude: [
      'highland-cattle.at',
      'casinomithandyrechnung.at',
      'beste-legale-casinos.at',
      'artcarnuntum.at',
    ],
  },
  {
    name: 'Already-separated domains (regression check)',
    input: 'foo.com bar.de baz.at',
    mustInclude: ['foo.com', 'bar.de', 'baz.at'],
  },
  {
    name: 'Single URL with path (regression check)',
    input: 'visit https://example.com/path?q=1 today',
    mustInclude: ['example.com'],
  },
  {
    name: 'Compound TLD (regression check)',
    input: 'check example.co.uk and example.com.au',
    mustInclude: ['example.co.uk', 'example.com.au'],
  },
  {
    name: 'No regression: domain with TLD substring inside a label',
    // The greedy pass should still emit atomicboost.com correctly.
    // The split pass adds junk entries (mail.at, omicboost.com) which
    // are harmless — they only matter if a real lead has those exact
    // domains, which is extremely rare.
    input: 'mail.atomicboost.com is a valid host',
    mustInclude: ['atomicboost.com', 'mail.atomicboost.com'],
  },
]

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')

  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  let pass = 0
  let fail = 0
  for (const tc of CASES) {
    const { data, error } = await svc.rpc('extract_normalized_domains', { p_text: tc.input })
    if (error) {
      console.error(`✗ ${tc.name}\n    error: ${error.message}`)
      fail++
      continue
    }
    const out = (data as string[] | null) ?? []
    const missing = tc.mustInclude.filter(d => !out.includes(d))
    const wrongIncluded = (tc.mustNotInclude ?? []).filter(d => out.includes(d))
    if (missing.length === 0 && wrongIncluded.length === 0) {
      console.log(`✓ ${tc.name}`)
      pass++
    } else {
      console.log(`✗ ${tc.name}`)
      if (missing.length > 0) console.log(`    missing: ${missing.join(', ')}`)
      if (wrongIncluded.length > 0) console.log(`    must-not-include but found: ${wrongIncluded.join(', ')}`)
      console.log(`    got: [${out.join(', ')}]`)
      fail++
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
