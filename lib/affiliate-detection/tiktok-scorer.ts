/**
 * TikTok creator affiliate scorer (Phase 3).
 *
 * Sibling of x-scorer.ts / fb-scorer.ts / kick-scorer.ts. A TikTok affiliate's
 * signal lives in: the single profile bio link (the funnel — a linktr.ee /
 * heylink hub, a shortener, or a casino redirector), the gambling language in
 * the bio + recent video captions, and a gambling-flavoured display name /
 * handle. This scorer reads all three. Pure + synchronous, so it runs in the
 * same inline server action as the link resolution with no extra I/O.
 *
 * Casino affiliates don't advertise on TikTok (gambling ads are banned), so —
 * exactly like the AU Facebook network — the strongest tell is the bio link
 * funnelling through an affiliate hub / masked shortener / referral-code path.
 * Reuses the gambling keyword lists from ./scorer.ts, the casino-link / hub
 * detection from ./kick-scorer.ts + ./fb-scorer.ts so all five classifiers
 * (lead site, Kick, YouTube, X, Facebook, TikTok) stay in sync.
 */

import { BONUS_COMPARISON_KEYWORDS, CASINO_KEYWORDS } from './scorer'
import { isAffiliateCasinoLink } from './kick-scorer'
import { AGGREGATOR_HOSTS } from './fb-scorer'

export type TiktokScoreCreator = {
  display_name: string | null
  username: string | null
  bio: string | null
  captions: string[] | null
}

export type TiktokScoreLink = {
  url: string
  resolved_url: string | null
}

export type TiktokScoreResult = {
  isLikelyAffiliate: boolean
  /** 0–100, two decimals — fits tiktok_creators.niche_score numeric(5,2). */
  nicheScore: number
  indicators: string[]
}

/** niche_score at/above which a creator is flagged an affiliate even without a
 *  directly-classified casino affiliate link. */
const AFFILIATE_THRESHOLD = 30

// Gambling terms in a display name / handle — a strong affiliate tell
// ("SlotsKing", "CasinoDaddy", "pokiesmate"). Broader than CASINO_KEYWORDS
// because names use gambl/pokies/wager/stake that the link-keyword list omits.
const NAME_GAMBLING_RE = /casino|slots?|pokies?|gambl|\bbet(ting)?\b|roulette|blackjack|poker|jackpot|wager|stake|bonus/i

// URL shorteners commonly used to mask the affiliate redirect. Mirrors the
// resolver's SHORTENER_HOSTS + fb-scorer's (kept local so the scorer stays
// pure / no server-only import).
const SHORTENER_HOSTS = new Set([
  'tny.sh', 'bit.ly', 't.co', 'tinyurl.com', 'cutt.ly', 'ow.ly', 'rb.gy',
  'is.gd', 'short.gy', 'shorturl.at', 'rebrand.ly', 't.ly', 's.id', 'v.gd',
  'soo.gd', 'clck.ru', 'tiny.cc',
])

// Affiliate referral / campaign codes that ride in the URL path (not as
// query-param stags). Mirrors fb-scorer.ts.
const AFFILIATE_REF_RE = /\/RF[A-Z0-9]{4,}/i
const CAMPAIGN_CODE_RE = /\/[A-Za-z]{2}\d{6,}/

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function scoreTiktokCreator(
  creator: TiktokScoreCreator,
  links: TiktokScoreLink[],
  casinoDenylist: Set<string>,
): TiktokScoreResult {
  const indicators: string[] = []
  let score = 0

  const dest = (l: TiktokScoreLink) => l.resolved_url ?? l.url
  // Distinct casino destinations + whether the creator funnels through an
  // affiliate hub, a masked shortener, or a referral-code path.
  const casinoHosts = new Set<string>()
  const hubHosts = new Set<string>()
  let shortenerHit = false
  let affiliatePathHit = false
  for (const l of links) {
    const url = dest(l)
    const host = hostOf(url)
    if (AGGREGATOR_HOSTS.has(host)) hubHosts.add(host)
    const urlIsShort = SHORTENER_HOSTS.has(hostOf(l.url))
    if (urlIsShort) shortenerHit = true
    for (const p of [l.url, l.resolved_url]) {
      if (!p) continue
      if (AFFILIATE_REF_RE.test(p) || (urlIsShort && CAMPAIGN_CODE_RE.test(p))) affiliatePathHit = true
    }
    if (!isAffiliateCasinoLink(url, casinoDenylist)) continue
    try {
      casinoHosts.add(new URL(url).hostname.toLowerCase().replace(/^www\./, ''))
    } catch {
      casinoHosts.add(url)
    }
  }

  // Casino affiliate links are the strongest signal: one is already
  // convincing, each additional distinct operator adds a little (capped).
  if (casinoHosts.size > 0) {
    score += 25 + Math.min(casinoHosts.size - 1, 4) * 10
    indicators.push(
      `${casinoHosts.size} casino affiliate link${casinoHosts.size === 1 ? '' : 's'}` +
        `: ${[...casinoHosts].slice(0, 5).join(', ')}`,
    )
  }

  // Gambling language across the bio + recent video captions.
  const text = `${creator.bio ?? ''} ${(creator.captions ?? []).join(' ')}`.toLowerCase()

  const kwHits = CASINO_KEYWORDS.filter(k => text.includes(k))
  if (kwHits.length > 0) {
    score += Math.min(kwHits.length * 3, 12)
    indicators.push(`casino keywords: ${kwHits.join(', ')}`)
  }

  const bonusHit = BONUS_COMPARISON_KEYWORDS.some(k => text.includes(k))
  if (bonusHit) {
    score += 5
    indicators.push('bonus / free-spins language')
  }

  // Display name / handle is a strong signal — a "CasinoDaddy" / "pokiesmate"
  // account surfaced by a casino keyword is almost always affiliate-adjacent.
  const nameHit =
    (creator.display_name && NAME_GAMBLING_RE.test(creator.display_name) && creator.display_name) ||
    (creator.username && NAME_GAMBLING_RE.test(creator.username) && `@${creator.username}`) ||
    null
  if (nameHit) {
    score += 15
    indicators.push(`gambling name: ${nameHit}`)
  }

  // Whether the creator shows ANY gambling context — gates the hub/shortener
  // signals so we don't flag generic creators who merely use linktr.ee/bit.ly.
  const hasGamblingContext = kwHits.length > 0 || bonusHit || !!nameHit

  if (hubHosts.size > 0 && hasGamblingContext) {
    score += 30
    indicators.push(`affiliate link hub: ${[...hubHosts].join(', ')}`)
  }
  if (shortenerHit && hasGamblingContext) {
    score += 22
    indicators.push('casino tracking / shortener link')
  }
  if (affiliatePathHit) {
    score += 25
    indicators.push('affiliate referral code in link path')
  }

  const nicheScore = Math.min(Math.round(score * 100) / 100, 100)
  const isLikelyAffiliate =
    casinoHosts.size > 0 ||
    (hubHosts.size > 0 && hasGamblingContext) ||
    (shortenerHit && hasGamblingContext) ||
    affiliatePathHit ||
    nicheScore >= AFFILIATE_THRESHOLD

  return { isLikelyAffiliate, nicheScore, indicators }
}
