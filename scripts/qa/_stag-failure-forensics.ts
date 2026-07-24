/**
 * Forensic dig into the WORST-performing domains from the baseline
 * audit. For each of the top-15 zero-success domains: sample lead
 * URLs + the redirect chain we captured + any HTML tag traces.
 *
 * The goal is to answer, per domain, "what mechanism IS this site
 * using to track affiliates that our extractor missed?" so we know
 * which of the additional research ideas would actually help.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

// Top zero-success domains from the baseline audit output
const TARGET_DOMAINS = [
  'gameshub.com',
  'cardplayer.com',
  'pokerfirma.com',
  'hochgepokert.com',
  'casinobeats.com',
  'betvictor.com',
  'betway.com',
  'ligaportal.at',
  'wette.de',
  'sportsline.com',
  'casino.netbet.com',
  'freep.com',
  'bestnewzealandcasinos.com',
  'casinos.at',
  'royalpanda.com',
]

function rootDomain(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

;(async () => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  console.log('=== Forensic dig on top zero-success domains ===\n')
  for (const target of TARGET_DOMAINS) {
    console.log(`\n--- ${target} ---`)

    // Sample up to 3 lead rows from this domain
    const { data: leads } = await s
      .from('google_lead_gen_table')
      .select('id, url, country_code, keyword, has_s_tags, html_tags')
      .eq('is_affiliate', true)
      .gte('s_tags_checked_at', since)
      .ilike('url', `%${target}%`)
      .order('id', { ascending: false })
      .limit(50)
    const rows = ((leads ?? []) as Array<{
      id: number
      url: string | null
      country_code: string | null
      keyword: string | null
      has_s_tags: boolean | null
      html_tags: unknown
    }>).filter(l => rootDomain(l.url) === target).slice(0, 3)

    if (rows.length === 0) {
      console.log('  (no leads found)')
      continue
    }

    for (const l of rows) {
      console.log(`  lead ${l.id}  cc=${l.country_code}  kw="${(l.keyword ?? '').slice(0, 40)}"`)
      console.log(`    url: ${l.url}`)
      const htmlTags = l.html_tags as null | { a?: string[]; meta?: string[]; script?: string[] }
      const anchors = htmlTags?.a ?? []
      const metas = htmlTags?.meta ?? []
      const scripts = htmlTags?.script ?? []
      console.log(`    captured: a=${anchors.length}  meta=${metas.length}  script=${scripts.length}`)

      // Look for tag-shape strings in the captured metadata
      const allText = [...anchors, ...metas, ...scripts].join(' ')
      const suspicious: string[] = []
      const patterns = [
        { name: 'btag=', rx: /\bbtag=[\w-]+/gi },
        { name: 'stag=', rx: /\bstag=[\w-]+/gi },
        { name: 'cxd=', rx: /\bcxd=[\w-]+/gi },
        { name: 'aff_id=', rx: /\baff_id=[\w-]+/gi },
        { name: 'irclickid=', rx: /\birclickid=[\w-]+/gi },
        { name: 'iaID=', rx: /\biaid=[\w-]+/gi },
        { name: 'a_aid=', rx: /\ba_aid=[\w-]+/gi },
        { name: 'ef_click=', rx: /\bef_click=[\w-]+/gi },
        { name: 'ranMID=', rx: /\branmid=[\w-]+/gi },
      ]
      for (const p of patterns) {
        const found = allText.match(p.rx)
        if (found) suspicious.push(`${p.name}${found.length}`)
      }

      // Recognizable network hosts in the anchors
      const networkHostHits = new Set<string>()
      for (const a of anchors) {
        if (/cellxpert|myaffiliates|netrefer|impact\.com|everflow|ef_click|iaID|income-access|postaffiliatepro|hasoffers|linksynergy|admitad|kwanko|netaffiliation|smartaffiliates|affilka|anrdoezrs|dpbolvw/i.test(a)) {
          // Isolate just the host
          const m = a.match(/https?:\/\/([^/"' ]+)/i)
          if (m && m[1]) networkHostHits.add(m[1])
        }
      }

      console.log(`    tag-pattern hits in html_tags: ${suspicious.length ? suspicious.join(', ') : '(none)'}`)
      if (networkHostHits.size > 0) {
        console.log(`    known network host hits: ${[...networkHostHits].slice(0, 3).join(', ')}`)
      }

      // Show top 3 anchor examples that at least look tracker-shaped
      const trackerLike = anchors
        .filter(a => /\?/.test(a) || /\/(go|out|track|click|aff|ref)\//i.test(a))
        .slice(0, 3)
      if (trackerLike.length > 0) {
        console.log(`    sample tracker-shaped anchors:`)
        for (const a of trackerLike) console.log(`      ${a.slice(0, 140)}`)
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1) })
