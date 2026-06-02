/**
 * Kick streamer affiliate scorer (Phase 3).
 *
 * Unlike scoreAffiliate() in ./scorer.ts — which reads rendered HTML of an
 * affiliate *review site* — a Kick streamer's affiliate signal is structured
 * and far cleaner: the casino promo cards, affiliate-ref links, gambling
 * tags, and casino keywords captured in Phase 1/2. This scorer reads those
 * directly. Pure + synchronous, so it runs in a server action with no I/O.
 *
 * Reuses the gambling keyword lists from ./scorer.ts so both classifiers
 * stay in sync. Written platform-light so it can be reused for Twitch.
 */

import { BONUS_COMPARISON_KEYWORDS, CASINO_KEYWORDS } from './scorer'

export type KickScoreStreamer = {
  channel_description: string | null
  stream_title: string | null
  custom_tags: string[] | null
  category_name: string | null
}

export type KickScoreLink = {
  url: string
  resolved_url: string | null
  source: string // 'channel_description' | 'stream_title' | 'promo_card' | 'pinned_chat'
  promo_brand: string | null
  promo_bonus_terms: string | null
}

export type KickScoreResult = {
  isLikelyAffiliate: boolean
  /** 0–100, two decimals — fits kick_streamers.niche_score numeric(5,2). */
  nicheScore: number
  indicators: string[]
}

/** niche_score at/above which a streamer is flagged an affiliate even
 *  without a directly-classified casino promo card. */
const AFFILIATE_THRESHOLD = 30

// Kick stream tags (custom_tags) that signal gambling content.
const GAMBLING_TAGS = new Set([
  'gambling', 'casino', 'slots', 'poker', 'blackjack', 'roulette',
  'betting', 'sportsbook', 'crypto casino', 'crash', 'plinko',
])

// Affiliate-ref markers seen on real Kick promo links — rainbet.com?r=,
// stake.com?c=, luxdrop.com/r/, plus the usual ref/aff/btag/clickid set.
// (scorer.ts's TRACKING_LINK_* regexes miss the single-letter ?r=/?c=//r/
// forms, so we keep a kick-specific pair here.)
const AFFILIATE_REF_QUERY_RE =
  /[?&](r|c|ref|aff|affiliate|btag|clickid|campaign|source|partner|promo|utm_source)=/i
const AFFILIATE_REF_PATH_RE = /\/(r|ref|go|visit|aff|partner|promo|join)\/[^/?#]/i

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function hostInDenylist(host: string, denylist: Set<string>): boolean {
  if (!host) return false
  for (const suffix of denylist) {
    if (host === suffix || host.endsWith('.' + suffix)) return true
  }
  return false
}

export function hasAffiliateRef(url: string): boolean {
  return AFFILIATE_REF_QUERY_RE.test(url) || AFFILIATE_REF_PATH_RE.test(url)
}

/** A link that points at a casino/affiliate destination: an affiliate-ref
 *  marker, a denylisted operator host, or a host containing a casino keyword
 *  (rainbet → "bet", etc.). The ref marker catches the ones the keyword
 *  misses (luxdrop /r/, stake ?c=); a streamer's own site (sweetflips.gg)
 *  and plain socials (discord, t.me) match none → correctly excluded. */
export function isAffiliateCasinoLink(url: string, denylist: Set<string>): boolean {
  const host = hostOf(url)
  if (!host) return false
  return (
    hasAffiliateRef(url) ||
    hostInDenylist(host, denylist) ||
    CASINO_KEYWORDS.some(k => host.includes(k))
  )
}

export function scoreKickStreamer(
  streamer: KickScoreStreamer,
  links: KickScoreLink[],
  casinoDenylist: Set<string>,
): KickScoreResult {
  const indicators: string[] = []
  let score = 0

  const dest = (l: KickScoreLink) => l.resolved_url ?? l.url
  const promoCasino = links.filter(
    l => l.source === 'promo_card' && isAffiliateCasinoLink(dest(l), casinoDenylist),
  )
  const pinnedCasino = links.filter(
    l => l.source === 'pinned_chat' && isAffiliateCasinoLink(dest(l), casinoDenylist),
  )

  // Casino promo cards are the strongest signal: one is already convincing,
  // each additional adds a little (capped). 25 → 65 for 1 → 5+ cards.
  if (promoCasino.length > 0) {
    score += 25 + Math.min(promoCasino.length - 1, 4) * 10
    const brands = [...new Set(promoCasino.map(l => l.promo_brand).filter(Boolean))]
    indicators.push(
      `${promoCasino.length} casino promo card${promoCasino.length === 1 ? '' : 's'}` +
        (brands.length ? `: ${brands.join(', ')}` : ''),
    )
  }

  // A casino affiliate link pinned in chat (classybeef's stake.com?c=).
  if (pinnedCasino.length > 0) {
    score += 15
    indicators.push('casino affiliate link in pinned chat')
  }

  // Streaming in a gambling category is a meaningful affiliate signal on
  // its own — and it survives when the casino-link panel didn't capture
  // (so a real affiliate like casinodaddy still surfaces). Kept modest so
  // category alone doesn't cross the threshold without a second signal.
  const category = (streamer.category_name ?? '').toLowerCase()
  if (/casino|slots|gambl|poker|roulette|blackjack|bet/.test(category)) {
    score += 12
    indicators.push(`gambling category: ${streamer.category_name}`)
  }

  const tags = (streamer.custom_tags ?? []).map(t => t.toLowerCase().trim())
  const gamblingTags = [...new Set(tags.filter(t => GAMBLING_TAGS.has(t)))]
  if (gamblingTags.length > 0) {
    score += 15
    indicators.push(`gambling tag${gamblingTags.length === 1 ? '' : 's'}: ${gamblingTags.join(', ')}`)
  }

  const text = `${streamer.channel_description ?? ''} ${streamer.stream_title ?? ''}`.toLowerCase()
  const kwHits = CASINO_KEYWORDS.filter(k => text.includes(k))
  if (kwHits.length > 0) {
    score += Math.min(kwHits.length * 3, 12)
    indicators.push(`casino keywords: ${kwHits.join(', ')}`)
  }

  const bonusText = [
    text,
    ...links.map(l => l.promo_bonus_terms ?? ''),
  ].join(' ').toLowerCase()
  if (BONUS_COMPARISON_KEYWORDS.some(k => bonusText.includes(k))) {
    score += 5
    indicators.push('bonus / free-spins language')
  }

  const nicheScore = Math.min(Math.round(score * 100) / 100, 100)
  const isLikelyAffiliate =
    promoCasino.length > 0 || pinnedCasino.length > 0 || nicheScore >= AFFILIATE_THRESHOLD

  return { isLikelyAffiliate, nicheScore, indicators }
}
