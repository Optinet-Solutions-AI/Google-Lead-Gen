/**
 * One-off: query the 7 leads where S-tag ran in the last 7d but landed
 * zero tags, fetch each page's SSR HTML, run the patched same-host
 * extraction, and report links found per URL. Tells us what % of the
 * "zero tags landed" leads the fix actually unblocks.
 *
 * Caveat: SSR HTML only — pages that need JS to render their tracking
 * links will still show zero here. The VM Selenium flow handles JS
 * rendering, so a SSR zero isn't necessarily a real zero post-deploy.
 */
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
loadEnv({ path: join(process.cwd(), '.env.local') })

const ANCHOR_HREF_RE = /href=["']([^"']+)["']/gi
const TRACKING_PATH_RE = /\/(track|click|go|visit|out|redirect|creat|aff|ref|link|offer|bonus|promo)\//i
const TRACKING_QUERY_RE = /[?&](ref|aff|affiliate|campaign|source|tracking|click)=/i
const EXCLUDED_HOSTS = new Set([
  'youtube.com', 'youtu.be', 'facebook.com', 'twitter.com', 'x.com',
  'instagram.com', 'tiktok.com', 'reddit.com', 'linkedin.com',
  'pinterest.com', 'wikipedia.org',
])

function isTrackingLink(url: string): boolean {
  if (!url) return false
  if (url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('tel:')) return false
  return TRACKING_PATH_RE.test(url) || TRACKING_QUERY_RE.test(url)
}

function extractTrackingLinks(html: string, baseUrl: string): string[] {
  const found = new Set<string>()
  for (const m of html.matchAll(ANCHOR_HREF_RE)) {
    const raw = m[1]
    if (!raw || !isTrackingLink(raw)) continue
    let absolute: string
    let host: string
    try {
      absolute = new URL(raw, baseUrl).toString()
      host = new URL(absolute).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      continue
    }
    if (!host || EXCLUDED_HOSTS.has(host)) continue
    found.add(absolute)
    if (found.size >= 50) break
  }
  return Array.from(found)
}

async function fetchHtml(url: string): Promise<{ ok: boolean; status: number; html: string; finalUrl: string }> {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    })
    const html = await r.text()
    return { ok: r.ok, status: r.status, html, finalUrl: r.url }
  } catch (e) {
    return { ok: false, status: 0, html: `(fetch error: ${(e as Error).message})`, finalUrl: url }
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

  const [tagRes, leadRes] = await Promise.all([
    svc.from('s_tags_table')
      .select('lead_id')
      .gte('created_at', since)
      .limit(5000),
    svc.from('google_lead_gen_table')
      .select('id, url, s_tags_checked_at')
      .gte('s_tags_checked_at', since)
      .order('s_tags_checked_at', { ascending: false })
      .limit(500),
  ])
  if (tagRes.error) throw tagRes.error
  if (leadRes.error) throw leadRes.error

  const leadsWithTags = new Set((tagRes.data ?? []).map(r => r.lead_id as number))
  const zeroTagLeads = (leadRes.data ?? []).filter(l => !leadsWithTags.has(l.id))
  console.log(`Found ${zeroTagLeads.length} zero-tag leads in last 7d. Fetching each in parallel...\n`)

  const results = await Promise.all(
    zeroTagLeads.map(async (l) => {
      const fr = await fetchHtml(String(l.url))
      const links = fr.ok ? extractTrackingLinks(fr.html, fr.finalUrl) : []
      return { lead: l, fr, links }
    }),
  )

  let totalLinks = 0
  let urlsWithLinks = 0
  let fetchFailures = 0
  for (const { lead, fr, links } of results) {
    console.log(`\n== lead ${lead.id}  ${lead.url}`)
    if (!fr.ok) {
      console.log(`   fetch failed: status=${fr.status} ${fr.html.slice(0, 100)}`)
      fetchFailures++
      continue
    }
    if (fr.finalUrl !== lead.url) console.log(`   redirected to: ${fr.finalUrl}`)
    console.log(`   status=${fr.status}  body=${fr.html.length}b  links=${links.length}`)
    totalLinks += links.length
    if (links.length > 0) urlsWithLinks++
    for (const u of links.slice(0, 8)) console.log(`     ${u}`)
    if (links.length > 8) console.log(`     ... +${links.length - 8} more`)
  }

  console.log(`\n=== SUMMARY ===`)
  console.log(`  total zero-tag leads tested: ${results.length}`)
  console.log(`  fetch failures (page unreachable from local box): ${fetchFailures}`)
  console.log(`  pages where fix now finds ≥1 tracking link: ${urlsWithLinks}`)
  console.log(`  pages where SSR still returns 0 links (likely JS-rendered or genuinely no tracking): ${results.length - fetchFailures - urlsWithLinks}`)
  console.log(`  total tracking links surfaced across all pages: ${totalLinks}`)
}
main().catch(e => { console.error(e); process.exit(1) })
