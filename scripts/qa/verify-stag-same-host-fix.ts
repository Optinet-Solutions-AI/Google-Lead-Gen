/**
 * Offline sanity check for the same-host-tracking-link fix in
 * vm/enrichment_worker.py. Loads two pages that returned zero tags in
 * prod (footitalia, betkiwi), runs the patched extraction logic
 * (mirrored faithfully from the Python in TypeScript), and prints the
 * tracking links it would now find.
 *
 * If this shows the /visit/.../ URLs, the deployed VM change will pick
 * them up too.
 */
import { readFileSync } from 'node:fs'

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
    // Patched: same-host kept on purpose — affiliate sites cloak outbound
    // links behind their own domain (e.g. /visit/brand/, /go/brand/).
    if (!host || EXCLUDED_HOSTS.has(host)) continue
    found.add(absolute)
    if (found.size >= 30) break
  }
  return Array.from(found)
}

const FIXTURE_DIR = 'C:/Users/terde/AppData/Local/Temp/stag-fix-check'
const CASES: [string, string][] = [
  [`${FIXTURE_DIR}/footitalia.html`, 'https://www.footitalia.com/gambling-sites/golden-panda/'],
  [`${FIXTURE_DIR}/betkiwi.html`,    'https://www.betkiwi.co.nz/online-casinos/golden-panda-casino/'],
]

for (const [path, base] of CASES) {
  let html = ''
  try { html = readFileSync(path, 'utf-8') }
  catch { console.error(`missing fixture: ${path}`); continue }
  const links = extractTrackingLinks(html, base)
  console.log(`\n== ${base}`)
  console.log(`   found ${links.length} tracking links`)
  for (const u of [...links].sort()) console.log(`     ${u}`)
}
