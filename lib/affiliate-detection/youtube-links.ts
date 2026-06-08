import 'server-only'

/**
 * YouTube affiliate-link resolution for Phase 3.
 *
 * A YouTube casino-affiliate channel rarely drops a raw casino tracking link
 * in its description — it links to a shortener (dub.sh/bit.ly) or to its OWN
 * review/landing page (gamblemojo.com/lp2/bestcasinosnz?utm_source=…). So the
 * SOP's "follow the affiliate link → extract the S-tag" is two-staged:
 *
 *   Shallow (cheap, every channel): collect the description's outbound links,
 *     follow shorteners to their final URL, classify casino-affiliate links,
 *     and parse any direct S-tag (btag/stag/cxd/mid/affid).
 *
 *   Two-hop (bounded, only the likely affiliates): fetch the creator's
 *     review/landing page and run the SAME outbound-link S-tag extractor the
 *     lead pipeline uses (extractStagsFromHtml) — that page's outbound casino
 *     links carry the real S-tags.
 *
 * Reuses resolveShortener/needsResolution, the extract.ts S-tag primitives,
 * and isAffiliateCasinoLink so YouTube stays in sync with the lead + Kick
 * affiliate logic.
 */

import { resolveShortener, needsResolution } from './resolve-links'
import { fetchHtml } from './fetch'
import {
  parseStagFromUrl,
  guessBrandFromUrl,
  extractStagsFromHtml,
  type ExtractedStag,
} from '@/lib/stag-extraction/extract'
import { isAffiliateCasinoLink } from './kick-scorer'

const URL_RE = /https?:\/\/[^\s)>\]"'}]+/gi

// Hosts that are never affiliate destinations: YouTube/Google chrome and the
// channel's own socials (those are handled as contacts, not S-tag sources).
const SKIP_SUFFIXES = [
  'youtube.com', 'youtu.be', 'google.com', 'gstatic.com', 'goo.gl',
  'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'facebook.com', 'fb.com', 'fb.me',
  't.me', 'telegram.me', 'telegram.dog', 'discord.gg', 'discord.com', 'discordapp.com',
  'whatsapp.com', 'wa.me', 'reddit.com', 'twitch.tv', 'kick.com', 'patreon.com',
]

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function isSkipHost(u: string): boolean {
  const h = hostOf(u)
  if (!h) return true
  return SKIP_SUFFIXES.some(s => h === s || h.endsWith('.' + s))
}

function cleanUrl(u: string): string {
  return u.replace(/[).,;!?'"]+$/, '')
}

export type ResolvedLink = {
  /** URL as it appeared in the description / website field. */
  source_url: string
  /** After following a shortener (or the source URL when no follow needed). */
  final_url: string
  /** Points at a casino/affiliate destination (denylist host, casino keyword,
   *  or an affiliate-ref param like ?ref=/?c=/utm_source). */
  is_casino: boolean
  /** A direct S-tag parsed straight off final_url (rare for YouTube). */
  s_tag: string | null
  s_tag_param: string | null
  brand: string | null
  /** A casino-affiliate page with no direct S-tag — worth a two-hop fetch to
   *  mine the page's own outbound casino links. */
  two_hop_candidate: boolean
}

/** Collect outbound affiliate-candidate URLs from a channel's text surfaces +
 *  its website field. Social/YouTube/Google links are dropped (deduped, capped). */
export function collectCandidates(texts: string[], websiteUrl: string | null, max = 4): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (u?: string | null) => {
    if (!u) return
    const c = cleanUrl(u.trim())
    if (!c || isSkipHost(c)) return
    const key = c.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }
  if (websiteUrl) push(websiteUrl) // the About-tab website link is the strongest candidate
  for (const t of texts) for (const m of (t || '').matchAll(URL_RE)) push(m[0])
  return out.slice(0, max)
}

/** Shallow pass for one candidate: follow a shortener, classify casino, parse a
 *  direct S-tag. Only shorteners trigger a network call — direct brand/landing
 *  URLs are classified as-is (cheap). */
export async function resolveCandidate(sourceUrl: string, denylist: Set<string>): Promise<ResolvedLink> {
  let final = sourceUrl
  if (needsResolution(sourceUrl)) {
    const r = await resolveShortener(sourceUrl)
    if (r) final = r
  }
  const parsed = parseStagFromUrl(final)
  const isCasino = !!parsed || isAffiliateCasinoLink(final, denylist)
  return {
    source_url: sourceUrl,
    final_url: final,
    is_casino: isCasino,
    s_tag: parsed?.tag ?? null,
    s_tag_param: parsed?.param ?? null,
    brand: guessBrandFromUrl(final),
    two_hop_candidate: isCasino && !parsed,
  }
}

/** Two-hop: fetch a candidate page and mine ITS outbound casino tracking links
 *  for S-tags (the real affiliate IDs live one hop in). Bounded + never throws. */
export async function twoHopStags(pageUrl: string, opts: { maxLinks?: number } = {}): Promise<ExtractedStag[]> {
  // Guarded fetcher (manual redirect + per-hop SSRF check): pageUrl derives
  // from a scraped video description, so a crafted link could 30x toward an
  // internal/metadata address.
  const res = await fetchHtml(pageUrl, 6000)
  if (!res.ok) return []
  // Cap the parsed slice — review pages are small; a runaway body shouldn't
  // blow the action's memory/time budget.
  const html = res.html.slice(0, 600_000)
  return extractStagsFromHtml(html, res.finalUrl, { maxLinks: opts.maxLinks ?? 10, concurrency: 5 })
}
