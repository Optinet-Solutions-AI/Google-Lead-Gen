/**
 * One-off backfill for PPC leads whose `url` field is a Google aclk
 * or Bing /aclk / /aclick / /ck/a click-tracker. The scheduler tick
 * (commit 6e0f77c + this fix) now decodes new leads on the fly, but
 * historical rows still carry the redirector URL — and any enrichment
 * that already ran against that URL screenshotted the redirect's
 * error page, not the real landing page.
 *
 * For each affected lead:
 *   1. Decode the redirector to the real destination via decodeAdUrl.
 *   2. UPDATE google_lead_gen_table.url to the decoded URL (so the
 *      drawer, link previews, and downstream analytics show the real
 *      site, not bing.com/aclk).
 *   3. Insert a fresh enrichment_fetch_queue row (status=pending,
 *      want_screenshot=true, process_stages=['affiliate']) so the
 *      next worker tick re-screenshots the lead against the real URL.
 *      The table has no uniqueness constraint on lead_id, so a new
 *      pending row coexists with the historical failed/completed row.
 *
 * Defaults to DRY RUN. Pass --apply to actually mutate.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { decodeAdUrl } from '@/lib/decode-ad-url'

loadEnv({ path: join(process.cwd(), '.env.local') })

function isRedirector(u: string) {
  return (
    u.includes('google.com/aclk') ||
    u.includes('googleadservices.com') ||
    u.includes('doubleclick.net') ||
    u.includes('bing.com/aclk') ||
    u.includes('bing.com/aclick') ||
    u.includes('bing.com/ck/a')
  )
}

/** Derive the `domain` column value from a decoded URL, matching the
 *  scraper's `full_url` format (`<scheme>://<host>`). Returns null if the
 *  decoded URL doesn't parse. */
function domainFromUrl(decoded: string): string | null {
  try {
    const u = new URL(decoded)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  // Page through ALL PPC leads so the backfill covers historical rows
  // — most redirector URLs we sampled were 1–6 weeks old.
  const pageSize = 1000
  let from = 0
  const affected: Array<{ id: number; country_code: string | null; oldUrl: string; newUrl: string; oldDomain: string | null; newDomain: string | null }> = []
  while (true) {
    const { data, error } = await svc
      .from('google_lead_gen_table')
      .select('id, country_code, url, domain, is_not_relevant')
      .eq('result_type', 'PPC')
      .order('id', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    const rows = (data ?? []) as Array<{ id: number; country_code: string | null; url: string | null; domain: string | null; is_not_relevant: boolean | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      if (!r.url || !r.country_code || r.is_not_relevant) continue
      if (!isRedirector(r.url)) continue
      const decoded = decodeAdUrl(r.url)
      if (decoded === r.url || !decoded.startsWith('http')) continue
      affected.push({ id: r.id, country_code: r.country_code, oldUrl: r.url, newUrl: decoded, oldDomain: r.domain, newDomain: domainFromUrl(decoded) })
    }
    if (rows.length < pageSize) break
    from += pageSize
  }

  console.log(`Found ${affected.length} PPC leads with decodable redirector URLs`)
  console.log(`Sample (first 5):`)
  for (const a of affected.slice(0, 5)) {
    console.log(`  id=${a.id}`)
    console.log(`    IN : ${a.oldUrl.slice(0, 120)}${a.oldUrl.length > 120 ? '…' : ''}`)
    console.log(`    OUT: ${a.newUrl.slice(0, 180)}`)
    console.log(`    domain: ${a.oldDomain ?? '(null)'} → ${a.newDomain ?? '(unchanged)'}`)
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to mutate.')
    return
  }

  console.log('\nApplying. This will:')
  console.log(`  - UPDATE google_lead_gen_table.url for ${affected.length} leads`)
  console.log(`  - INSERT ${affected.length} new enrichment_fetch_queue rows (pending, want_screenshot=true)`)

  // Chunked updates — Postgres + supabase-js handle these fine in
  // 500-row batches without timing out.
  const BATCH = 100
  let updated = 0, queued = 0
  for (let i = 0; i < affected.length; i += BATCH) {
    const slice = affected.slice(i, i + BATCH)
    await Promise.all(slice.map(async a => {
      // Update `domain` alongside `url` so the drawer + leads table show
      // the advertiser host, not bing.com. Only overwrite domain when we
      // could derive a real host from the decoded URL.
      const patch: { url: string; domain?: string } = { url: a.newUrl }
      if (a.newDomain) patch.domain = a.newDomain
      const { error: upErr } = await svc
        .from('google_lead_gen_table')
        .update(patch)
        .eq('id', a.id)
      if (upErr) {
        console.error(`  url update failed for id=${a.id}: ${upErr.message}`)
        return
      }
      updated++
    }))
    const inserts = slice.map(a => ({
      lead_id: a.id,
      country_code: a.country_code!,
      url: a.newUrl,
      want_html: true,
      want_screenshot: true,
      process_stages: ['affiliate'],
    }))
    const { error: insErr } = await svc.from('enrichment_fetch_queue').insert(inserts)
    if (insErr) console.error(`  fetch_queue insert failed for batch starting ${slice[0]?.id}: ${insErr.message}`)
    else queued += inserts.length
    process.stdout.write(`  progress: ${i + slice.length}/${affected.length}\r`)
  }
  console.log(`\nDone. urls updated=${updated}, fetch_queue rows queued=${queued}`)
}

main().catch(err => { console.error(err); process.exit(1) })
