/**
 * Twitch streamer affiliate scorer (Phase 3).
 *
 * Thin wrapper over the platform-light scoreKickStreamer (kick-scorer.ts was
 * written to be reused for Twitch). A Twitch streamer's affiliate signal lives
 * in the same shape of structured fields — bio, stream title, gambling game
 * category, stream tags, and the casino links captured in Phase 1.
 *
 * Source mapping onto the Kick scorer's link buckets:
 *   - 'panel' → 'promo_card'  : About-panel links are where Twitch casino
 *                               affiliates actually put their funnels — the
 *                               strongest signal, exactly like a Kick promo card.
 *   - 'bio'   → 'pinned_chat'  : second-tier (a casino link in the channel bio).
 *   - vod_description / clip_description / stream_title pass through unchanged —
 *     they still feed the casino-keyword text scan but don't get the strong
 *     per-link weighting (those surfaces are noisier than a curated panel).
 */

import {
  scoreKickStreamer,
  type KickScoreLink,
  type KickScoreResult,
} from './kick-scorer'

export type TwitchScoreStreamer = {
  bio: string | null
  stream_title: string | null
  tags: string[] | null
  game_name: string | null
}

export type TwitchScoreLink = {
  url: string
  resolved_url: string | null
  /** 'panel' | 'bio' | 'vod_description' | 'clip_description' | 'stream_title' */
  source: string
  brand: string | null
}

export type TwitchScoreResult = KickScoreResult

export function scoreTwitchStreamer(
  streamer: TwitchScoreStreamer,
  links: TwitchScoreLink[],
  casinoDenylist: Set<string>,
): TwitchScoreResult {
  const mapped: KickScoreLink[] = links.map(l => ({
    url: l.url,
    resolved_url: l.resolved_url,
    source: l.source === 'panel' ? 'promo_card' : l.source === 'bio' ? 'pinned_chat' : l.source,
    promo_brand: l.brand,
    promo_bonus_terms: null,
  }))
  return scoreKickStreamer(
    {
      channel_description: streamer.bio,
      stream_title: streamer.stream_title,
      custom_tags: streamer.tags,
      category_name: streamer.game_name,
    },
    mapped,
    casinoDenylist,
  )
}
