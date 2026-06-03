/**
 * X (x.com) creator affiliate scorer (Phase 3).
 *
 * Sibling of kick-scorer.ts / youtube-scorer.ts. An X affiliate's signal
 * lives in three places: the casino/gambling language in the bio + pinned
 * tweet, a gambling-flavoured display name / handle, and the affiliate
 * tracking links carried in the bio entities, the pinned tweet, and the
 * website card (resolved + S-tag-parsed in Phase 3 into x_links). This
 * scorer reads all three. Pure + synchronous, so it runs in the same inline
 * server action as the link resolution with no extra I/O.
 *
 * Reuses the gambling keyword lists from ./scorer.ts and the affiliate-ref /
 * casino-link detection from ./kick-scorer.ts so all four classifiers
 * (lead site, Kick, YouTube, X) stay in sync.
 */

import { BONUS_COMPARISON_KEYWORDS, CASINO_KEYWORDS } from './scorer'
import { isAffiliateCasinoLink } from './kick-scorer'

export type XScoreCreator = {
  display_name: string | null
  username: string | null
  bio: string | null
  pinned_tweet_text: string | null
}

export type XScoreLink = {
  url: string
  resolved_url: string | null
}

export type XScoreResult = {
  isLikelyAffiliate: boolean
  /** 0–100, two decimals — fits x_creators.niche_score numeric(5,2). */
  nicheScore: number
  indicators: string[]
}

/** niche_score at/above which a creator is flagged an affiliate even
 *  without a directly-classified casino affiliate link. */
const AFFILIATE_THRESHOLD = 30

// Gambling terms in a display name / handle — a strong affiliate tell on X
// ("SlotsKing", "CasinoDaddy", "BetWithMike"). Broader than CASINO_KEYWORDS
// because names use gambl/pokies/wager/stake that the link-keyword list omits.
const NAME_GAMBLING_RE = /casino|slots?|pokies?|gambl|\bbet(ting)?\b|roulette|blackjack|poker|jackpot|wager|stake|bonus/i

export function scoreXCreator(
  creator: XScoreCreator,
  links: XScoreLink[],
  casinoDenylist: Set<string>,
): XScoreResult {
  const indicators: string[] = []
  let score = 0

  const dest = (l: XScoreLink) => l.resolved_url ?? l.url
  // Distinct casino/affiliate destinations (dedupe by host so a creator who
  // links the same operator from both bio and pinned tweet isn't double-counted).
  const casinoHosts = new Set<string>()
  for (const l of links) {
    const url = dest(l)
    if (!isAffiliateCasinoLink(url, casinoDenylist)) continue
    try {
      casinoHosts.add(new URL(url).hostname.toLowerCase().replace(/^www\./, ''))
    } catch {
      casinoHosts.add(url)
    }
  }

  // Casino affiliate links are the strongest signal: one is already
  // convincing, each additional distinct operator adds a little (capped).
  // 25 → 65 for 1 → 5+ distinct casino destinations.
  if (casinoHosts.size > 0) {
    score += 25 + Math.min(casinoHosts.size - 1, 4) * 10
    indicators.push(
      `${casinoHosts.size} casino affiliate link${casinoHosts.size === 1 ? '' : 's'}` +
        `: ${[...casinoHosts].slice(0, 5).join(', ')}`,
    )
  }

  // Gambling language across the bio + pinned tweet.
  const text = `${creator.bio ?? ''} ${creator.pinned_tweet_text ?? ''}`.toLowerCase()

  const kwHits = CASINO_KEYWORDS.filter(k => text.includes(k))
  if (kwHits.length > 0) {
    score += Math.min(kwHits.length * 3, 12)
    indicators.push(`casino keywords: ${kwHits.join(', ')}`)
  }

  if (BONUS_COMPARISON_KEYWORDS.some(k => text.includes(k))) {
    score += 5
    indicators.push('bonus / free-spins language')
  }

  // Display name / handle is a strong signal — a "CasinoDaddy" / "SlotsKing"
  // account surfaced by a casino keyword is almost always affiliate-adjacent
  // even before we resolve its links. Check both (name first for the label).
  const nameHit =
    (creator.display_name && NAME_GAMBLING_RE.test(creator.display_name) && creator.display_name) ||
    (creator.username && NAME_GAMBLING_RE.test(creator.username) && `@${creator.username}`) ||
    null
  if (nameHit) {
    score += 15
    indicators.push(`gambling name: ${nameHit}`)
  }

  const nicheScore = Math.min(Math.round(score * 100) / 100, 100)
  // Affiliate if it links to a casino at all, OR clears the threshold on the
  // softer signals (name + keywords + a resolved promo destination).
  const isLikelyAffiliate = casinoHosts.size > 0 || nicheScore >= AFFILIATE_THRESHOLD

  return { isLikelyAffiliate, nicheScore, indicators }
}
