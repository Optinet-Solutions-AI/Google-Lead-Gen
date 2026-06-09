/**
 * YouTube channel affiliate scorer (Phase 3).
 *
 * Sibling of kick-scorer.ts. A YouTube affiliate's signal lives in two
 * places: the casino/gambling language in the channel + recent video
 * descriptions, and the affiliate-tracking links those descriptions carry
 * (resolved + S-tag-parsed in Phase 3 into youtube_channel_links). This
 * scorer reads both. Pure + synchronous, so it runs in the same inline
 * server action as the link resolution with no extra I/O.
 *
 * Reuses the gambling keyword lists from ./scorer.ts and the affiliate-ref
 * / casino-link detection from ./kick-scorer.ts so all three classifiers
 * stay in sync.
 */

import { BONUS_COMPARISON_KEYWORDS, CASINO_KEYWORDS } from './scorer'
import { isAffiliateCasinoLink } from './kick-scorer'

export type YoutubeScoreChannel = {
  channel_name: string | null
  channel_description: string | null
  recent_video_descriptions: string[] | null
}

// Gambling terms in a channel NAME — a strong YouTube affiliate tell
// ("GambleMojo", "Cowboy Slots", "NZ Pokies"). Broader than CASINO_KEYWORDS
// because channel names use gambl/pokies/wager that the link-keyword list omits.
const NAME_GAMBLING_RE = /casino|slots?|pokies?|gambl|\bbet(ting)?\b|roulette|blackjack|poker|jackpot|wager|bonus/i

export type YoutubeScoreLink = {
  url: string
  resolved_url: string | null
}

export type YoutubeScoreResult = {
  isLikelyAffiliate: boolean
  /** No outbound casino affiliate link → slot-gameplay vlogger / land-based
   *  casino channel / news, not an actionable affiliate. Hidden from the
   *  default results view (a "Show all" toggle reveals it). */
  isNotRelevant: boolean
  /** 0–100, two decimals — fits youtube_channels.niche_score numeric(5,2). */
  nicheScore: number
  indicators: string[]
}

export function scoreYoutubeChannel(
  channel: YoutubeScoreChannel,
  links: YoutubeScoreLink[],
  casinoDenylist: Set<string>,
): YoutubeScoreResult {
  const indicators: string[] = []
  let score = 0

  const dest = (l: YoutubeScoreLink) => l.resolved_url ?? l.url
  // Distinct casino/affiliate destinations (dedupe by host so a channel
  // that links the same operator in every video isn't over-counted).
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

  // Gambling language across the channel bio + recent video descriptions.
  const text = [
    channel.channel_description ?? '',
    ...(channel.recent_video_descriptions ?? []),
  ]
    .join(' ')
    .toLowerCase()

  const kwHits = CASINO_KEYWORDS.filter(k => text.includes(k))
  if (kwHits.length > 0) {
    score += Math.min(kwHits.length * 3, 12)
    indicators.push(`casino keywords: ${kwHits.join(', ')}`)
  }

  if (BONUS_COMPARISON_KEYWORDS.some(k => text.includes(k))) {
    score += 5
    indicators.push('bonus / free-spins language')
  }

  // Channel name is a strong signal on YouTube — a "GambleMojo" / "Cowboy
  // Slots" / "NZ Pokies" channel surfaced by a casino keyword is almost
  // always affiliate-adjacent even before we resolve its links.
  if (channel.channel_name && NAME_GAMBLING_RE.test(channel.channel_name)) {
    score += 15
    indicators.push(`gambling channel name: ${channel.channel_name}`)
  }

  const nicheScore = Math.min(Math.round(score * 100) / 100, 100)

  // Relevance gate (Darren 2026-06-09: ~90% of AU "pokies big win"-style
  // scrapes are slot-gameplay vloggers / land-based-casino vlogs / even a news
  // program — irrelevant). YouTube's twist vs TikTok: gambling/slots GAMEPLAY
  // content is allowed and EVERYWHERE here, so a gambling name/keywords/bonus-
  // language signal is NOT evidence of an affiliate — every pokie vlogger trips
  // it (and used to clear the old soft 30-point threshold with zero links). The
  // only actionable tell of a casino affiliate is an outbound casino affiliate
  // FUNNEL link in the channel / video descriptions. No such link → content,
  // not a lead → not relevant (hidden by default; "Show all" reveals it, and
  // niche_score is still kept so the soft signals rank within the full set).
  const hasCasinoFunnel = casinoHosts.size > 0
  const isLikelyAffiliate = hasCasinoFunnel
  const isNotRelevant = !hasCasinoFunnel

  return { isLikelyAffiliate, isNotRelevant, nicheScore, indicators }
}
