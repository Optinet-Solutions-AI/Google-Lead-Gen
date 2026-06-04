/**
 * Facebook Ad Library advertiser affiliate scorer (Phase 3).
 *
 * Sibling of x-scorer.ts / kick-scorer.ts / youtube-scorer.ts. A Facebook
 * advertiser's affiliate signal lives in three places: the casino/gambling
 * landing + CTA links carried in their ads, the gambling language in their
 * sampled ad copy + Page category, and a gambling-flavoured Page name. This
 * scorer reads all three. Pure + synchronous, so it runs in the same inline
 * server action as the link resolution with no extra I/O.
 *
 * Facebook Pages have no bio/pinned post like X, so the keyword surface is
 * `ad_text_sample` (sampled ad copy gathered in Phase 1/2) plus the Page
 * category. The link signal is the strongest tell — an advertiser whose ads
 * point at a casino affiliate destination is almost always an affiliate.
 *
 * Reuses the gambling keyword lists from ./scorer.ts and the affiliate-ref /
 * casino-link detection from ./kick-scorer.ts so all five classifiers (lead
 * site, Kick, YouTube, X, Facebook) stay in sync.
 */

import { BONUS_COMPARISON_KEYWORDS, CASINO_KEYWORDS } from './scorer'
import { isAffiliateCasinoLink } from './kick-scorer'

export type FbScoreAdvertiser = {
  page_name: string | null
  page_category: string | null
  ad_text_sample: string | null
}

export type FbScoreLink = {
  url: string
  resolved_url: string | null
}

export type FbScoreResult = {
  isLikelyAffiliate: boolean
  /** 0–100, two decimals — fits fb_advertisers.niche_score numeric(5,2). */
  nicheScore: number
  indicators: string[]
}

/** niche_score at/above which an advertiser is flagged an affiliate even
 *  without a directly-classified casino affiliate link. */
const AFFILIATE_THRESHOLD = 30

// Gambling terms in a Page name — a strong affiliate tell on Facebook
// ("SlotsKing", "CasinoDaddy", "BetWithMike"). Broader than CASINO_KEYWORDS
// because names use gambl/pokies/wager/stake that the link-keyword list omits.
const NAME_GAMBLING_RE = /casino|slots?|pokies?|gambl|\bbet(ting)?\b|roulette|blackjack|poker|jackpot|wager|stake|bonus/i

export function scoreFbAdvertiser(
  advertiser: FbScoreAdvertiser,
  links: FbScoreLink[],
  casinoDenylist: Set<string>,
): FbScoreResult {
  const indicators: string[] = []
  let score = 0

  const dest = (l: FbScoreLink) => l.resolved_url ?? l.url
  // Distinct casino/affiliate destinations (dedupe by host so an advertiser
  // who points many ads at the same operator isn't double-counted).
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

  // Gambling language across the sampled ad copy + Page category.
  const text = `${advertiser.ad_text_sample ?? ''} ${advertiser.page_category ?? ''}`.toLowerCase()

  const kwHits = CASINO_KEYWORDS.filter(k => text.includes(k))
  if (kwHits.length > 0) {
    score += Math.min(kwHits.length * 3, 12)
    indicators.push(`casino keywords: ${kwHits.join(', ')}`)
  }

  if (BONUS_COMPARISON_KEYWORDS.some(k => text.includes(k))) {
    score += 5
    indicators.push('bonus / free-spins language')
  }

  // Page name is a strong signal — a "CasinoDaddy" / "SlotsKing" advertiser
  // surfaced by a casino keyword is almost always affiliate-adjacent even
  // before we resolve its ad links.
  const nameHit =
    advertiser.page_name && NAME_GAMBLING_RE.test(advertiser.page_name)
      ? advertiser.page_name
      : null
  if (nameHit) {
    score += 15
    indicators.push(`gambling name: ${nameHit}`)
  }

  const nicheScore = Math.min(Math.round(score * 100) / 100, 100)
  // Affiliate if it points an ad at a casino at all, OR clears the threshold
  // on the softer signals (name + keywords + a resolved promo destination).
  const isLikelyAffiliate = casinoHosts.size > 0 || nicheScore >= AFFILIATE_THRESHOLD

  return { isLikelyAffiliate, nicheScore, indicators }
}
