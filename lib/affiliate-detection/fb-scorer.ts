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

// Link-aggregator "hub" pages — an advertiser funnelling traffic through one of
// these (heylink/linktree-style) is the signature of an affiliate marketer, not
// a direct operator. These are 200-OK pages (not 30x), so the resolver can't
// expand them; we score the *presence* of the hub instead. Only counts when the
// Page also shows gambling context (so we don't flag every creator on heylink).
export const AGGREGATOR_HOSTS = new Set([
  'heylink.me', 'linktr.ee', 'beacons.ai', 'bio.link', 'lnk.bio', 'linkr.bio',
  'allmylinks.com', 'linkin.bio', 'solo.to', 'tap.bio', 'msha.ke', 'about.me',
])

// URL shorteners commonly used to mask the affiliate redirect. When one of these
// appears on a gambling-context Page but DIDN'T resolve to a casino (blocked /
// not followed), treat it as a likely casino-affiliate redirect. Mirrors the
// resolver's SHORTENER_HOSTS (kept local so the scorer stays pure/no server-only).
const SHORTENER_HOSTS = new Set([
  'tny.sh', 'bit.ly', 't.co', 'tinyurl.com', 'cutt.ly', 'ow.ly', 'rb.gy',
  'is.gd', 'short.gy', 'shorturl.at', 'rebrand.ly', 't.ly', 's.id', 'v.gd',
  'soo.gd', 'clck.ru', 'tiny.cc',
])

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Affiliate referral / campaign codes that ride in the URL *path* (not as
// query-param stags, so parseStagFromUrl never sees them). Two shapes seen in
// the AU Facebook gambling network:
//   - explicit referral codes on the operator: .../RFOGAD007, .../RF030AFB08S
//   - masked campaign codes inside the shortener: tny.sh/AU40326002-FC,
//     tny.sh/au306253codb  (2 letters + 6+ digits)
// AFFILIATE_REF_RE is distinctive enough to count anywhere; CAMPAIGN_CODE_RE is
// looser, so it only counts on a shortener link (the masking IS the tell).
const AFFILIATE_REF_RE = /\/RF[A-Z0-9]{4,}/i
const CAMPAIGN_CODE_RE = /\/[A-Za-z]{2}\d{6,}/

export function scoreFbAdvertiser(
  advertiser: FbScoreAdvertiser,
  links: FbScoreLink[],
  casinoDenylist: Set<string>,
): FbScoreResult {
  const indicators: string[] = []
  let score = 0

  const dest = (l: FbScoreLink) => l.resolved_url ?? l.url
  // Distinct casino/affiliate destinations (dedupe by host so an advertiser
  // who points many ads at the same operator isn't double-counted). Along the
  // way, note whether the Page funnels traffic through an affiliate link-hub or
  // a (still-unresolved) shortener — both are strong affiliate tells once the
  // Page also shows gambling context (checked below).
  const casinoHosts = new Set<string>()
  const hubHosts = new Set<string>()
  let shortenerHit = false
  let affiliatePathHit = false
  for (const l of links) {
    const url = dest(l)
    const host = hostOf(url)
    if (AGGREGATOR_HOSTS.has(host)) hubHosts.add(host)
    // Funnelling an ad through a shortener is the affiliate behaviour — count it
    // whether or not it resolved. (Keying on the resolved host instead would
    // DROP the signal exactly when resolution succeeds and lands on an obscure
    // operator that isn't in the casino denylist — e.g. tny.sh → iplay77.com.)
    const urlIsShort = SHORTENER_HOSTS.has(hostOf(l.url))
    if (urlIsShort) shortenerHit = true
    // Affiliate referral / campaign code in the path of the original OR resolved
    // URL — a self-standing affiliate tell that needs no ad-copy keywords.
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

  const bonusHit = BONUS_COMPARISON_KEYWORDS.some(k => text.includes(k))
  if (bonusHit) {
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

  // Whether the Page shows ANY gambling context — gates the hub/shortener
  // signals so we don't flag generic creators who merely use heylink/bit.ly.
  const hasGamblingContext = kwHits.length > 0 || bonusHit || !!nameHit

  // An affiliate link-hub (heylink/linktree-style) on a gambling-context Page is
  // the classic affiliate-marketer signature — strong enough to flag on its own.
  if (hubHosts.size > 0 && hasGamblingContext) {
    score += 30
    indicators.push(`affiliate link hub: ${[...hubHosts].join(', ')}`)
  }
  // A still-unresolved shortener on a gambling-context Page is almost always a
  // masked casino-affiliate redirect (e.g. tny.sh/AU…-FT, rb.gy/…).
  if (shortenerHit && hasGamblingContext) {
    score += 22
    indicators.push('casino tracking / shortener link')
  }

  // An affiliate referral/campaign code in a link path is a self-standing tell —
  // it flags even when the sampled ad copy carried no gambling keyword (the
  // thin-copy stragglers whose only signal is the resolved .../RF… casino link).
  if (affiliatePathHit) {
    score += 25
    indicators.push('affiliate referral code in link path')
  }

  const nicheScore = Math.min(Math.round(score * 100) / 100, 100)
  // Affiliate if it points an ad at a casino at all, funnels through an
  // affiliate hub / masked shortener with gambling context, carries an
  // affiliate referral code in a link path, OR clears the threshold on the
  // softer signals (name + keywords).
  const isLikelyAffiliate =
    casinoHosts.size > 0 ||
    (hubHosts.size > 0 && hasGamblingContext) ||
    (shortenerHit && hasGamblingContext) ||
    affiliatePathHit ||
    nicheScore >= AFFILIATE_THRESHOLD

  return { isLikelyAffiliate, nicheScore, indicators }
}
