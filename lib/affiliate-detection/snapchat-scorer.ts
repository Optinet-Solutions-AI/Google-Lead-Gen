/**
 * Snapchat creator affiliate scorer (Phase 3).
 *
 * Sibling of tiktok-scorer.ts / x-scorer.ts / fb-scorer.ts. A Snapchat
 * affiliate's signal lives in: the single profile bio link (websiteUrl — a
 * linktr.ee / heylink hub, a shortener, or a casino redirector), gambling
 * language in the bio, and a gambling-flavoured display name / handle. Pure +
 * synchronous, so it runs in the same inline server action as link resolution.
 *
 * Reuses the gambling keyword lists from ./scorer.ts, the casino-link / hub
 * detection from ./kick-scorer.ts + ./fb-scorer.ts so all classifiers stay in
 * sync.
 */

import { BONUS_COMPARISON_KEYWORDS, CASINO_KEYWORDS } from './scorer'
import { isAffiliateCasinoLink } from './kick-scorer'
import { AGGREGATOR_HOSTS } from './fb-scorer'

export type SnapchatScoreCreator = {
  display_name: string | null
  username: string | null
  bio: string | null
}

export type SnapchatScoreLink = {
  url: string
  resolved_url: string | null
}

export type SnapchatScoreResult = {
  isLikelyAffiliate: boolean
  /** No outbound affiliate funnel link in the bio → a lifestyle / land-based /
   *  slot-gameplay account, not an actionable affiliate. Hidden from the
   *  default results view (a "Show all" toggle reveals it). */
  isNotRelevant: boolean
  /** 0–100, two decimals — fits snapchat_creators.niche_score numeric(5,2). */
  nicheScore: number
  indicators: string[]
}

const NAME_GAMBLING_RE = /casino|slots?|pokies?|gambl|\bbet(ting)?\b|roulette|blackjack|poker|jackpot|wager|stake|bonus/i

const SHORTENER_HOSTS = new Set([
  'tny.sh', 'bit.ly', 't.co', 'tinyurl.com', 'cutt.ly', 'ow.ly', 'rb.gy',
  'is.gd', 'short.gy', 'shorturl.at', 'rebrand.ly', 't.ly', 's.id', 'v.gd',
  'soo.gd', 'clck.ru', 'tiny.cc',
])

const AFFILIATE_REF_RE = /\/RF[A-Z0-9]{4,}/i
const CAMPAIGN_CODE_RE = /\/[A-Za-z]{2}\d{6,}/

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function scoreSnapchatCreator(
  creator: SnapchatScoreCreator,
  links: SnapchatScoreLink[],
  casinoDenylist: Set<string>,
): SnapchatScoreResult {
  const indicators: string[] = []
  let score = 0

  const dest = (l: SnapchatScoreLink) => l.resolved_url ?? l.url
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

  if (casinoHosts.size > 0) {
    score += 25 + Math.min(casinoHosts.size - 1, 4) * 10
    indicators.push(
      `${casinoHosts.size} casino affiliate link${casinoHosts.size === 1 ? '' : 's'}` +
        `: ${[...casinoHosts].slice(0, 5).join(', ')}`,
    )
  }

  const text = `${creator.bio ?? ''}`.toLowerCase()

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

  const nameHit =
    (creator.display_name && NAME_GAMBLING_RE.test(creator.display_name) && creator.display_name) ||
    (creator.username && NAME_GAMBLING_RE.test(creator.username) && `@${creator.username}`) ||
    null
  if (nameHit) {
    score += 15
    indicators.push(`gambling name: ${nameHit}`)
  }

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

  // Relevance gate (Darren 2026-06-09 "Snapchat - Leads Relevance": the AU/DE
  // casino scrapes surfaced 35/26 creators — a university, hotels, Ford, travel
  // / lifestyle vloggers, slot-gameplay accounts — none affiliates). Snapchat's
  // only actionable affiliate tell is an outbound FUNNEL in the bio link: a
  // classified casino host, a link hub / shortener alongside gambling context,
  // or an affiliate referral code in the link path. A gambling-flavoured name
  // or bio keywords WITHOUT such a link is content, not a lead — it used to
  // clear the old soft 30-point threshold (e.g. @rajaslots, a slot-gameplay
  // site, with zero funnel) and flood the results. No funnel → not relevant
  // (hidden by default; "Show all" reveals it, and niche_score is still kept so
  // the soft signals rank within the full set).
  const hasFunnelLink =
    casinoHosts.size > 0 ||
    (hubHosts.size > 0 && hasGamblingContext) ||
    (shortenerHit && hasGamblingContext) ||
    affiliatePathHit
  const isLikelyAffiliate = hasFunnelLink
  const isNotRelevant = !hasFunnelLink

  return { isLikelyAffiliate, isNotRelevant, nicheScore, indicators }
}
