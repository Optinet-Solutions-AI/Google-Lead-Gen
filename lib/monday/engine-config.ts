/**
 * Per-engine config for the job-level "Push to Monday" feature.
 *
 * Google/Bing scrapes produce rows in `google_lead_gen_table` and already
 * have a per-lead Push (see lib/monday/push-lead.ts). The 8 newer engines
 * each write their entities to their own table (+ a parallel `*_links`
 * table holding the resolved affiliate links / brand / s_tag). This
 * registry describes, per engine, where those rows live and which columns
 * map onto the Rooster "Leads" board, so one generic push routine can
 * handle all of them.
 *
 * Deliberately free of any `server-only` import so the local dry-run
 * preview script (scripts/qa/dry-push-job.ts) can import it too.
 */

/** Engines whose results are social-creator/advertiser entities pushed via
 *  the generic per-entity path. Google/Bing are NOT here — they go through
 *  the existing per-lead push over google_lead_gen_table. */
export type SocialEngine =
  | 'youtube'
  | 'kick'
  | 'twitch'
  | 'x'
  | 'facebook'
  | 'tiktok'
  | 'snapchat'
  | 'telegram'

export type EngineEntityConfig = {
  engine: SocialEngine
  /** Entity table (one row = one creator/channel/advertiser). */
  table: string
  /** Parallel links table holding resolved affiliate links. */
  linksTable: string
  /** FK column on the links table pointing at the entity row's id. */
  linksFk: string
  /** Label written into the board's "Source" column (status_1). Auto-created
   *  on Monday via create_labels_if_missing if it doesn't exist yet. */
  sourceLabel: string
  /** Entity columns tried in order to build the Monday item name. First
   *  non-empty wins; falls back to `${engine}-${id}` if all are empty. */
  nameCols: string[]
  /** Column holding the public profile URL (the entity's own page). */
  profileUrlCol: string
  /** Column holding a mined contact email, or null if the engine never
   *  captures one (twitch). */
  emailCol: string | null
  /** A direct "link in bio"/website column on the entity row, used as the
   *  Website (text1) when no resolved funnel link is on the links table.
   *  null when the engine has no such single column. */
  bioLinkCol: string | null
  /** Whether the entity table has an `is_not_relevant` gate to honour when
   *  selecting push candidates (youtube/tiktok/snapchat). */
  hasNotRelevant: boolean
  /** Brand column on the links table. Kick stores the casino brand under
   *  `promo_brand`; everyone else uses `brand`. */
  linkBrandCol: 'brand' | 'promo_brand'
  /** Whether the links table carries an `s_tag` column. Kick links don't
   *  (they only have promo_brand), so its s-tag update is skipped. */
  linkHasStag: boolean
}

export const ENGINE_CONFIGS: Record<SocialEngine, EngineEntityConfig> = {
  youtube: {
    engine: 'youtube',
    table: 'youtube_channels',
    linksTable: 'youtube_channel_links',
    linksFk: 'youtube_channel_id',
    sourceLabel: 'YouTube',
    nameCols: ['channel_name', 'channel_handle'],
    profileUrlCol: 'channel_url',
    emailCol: 'email',
    bioLinkCol: 'website_url',
    hasNotRelevant: true,
    linkBrandCol: 'brand',
    linkHasStag: true,
  },
  kick: {
    engine: 'kick',
    table: 'kick_streamers',
    linksTable: 'kick_links',
    linksFk: 'kick_streamer_id',
    sourceLabel: 'Kick',
    nameCols: ['slug'],
    profileUrlCol: 'channel_url',
    emailCol: 'contact_email',
    bioLinkCol: null,
    hasNotRelevant: false,
    linkBrandCol: 'promo_brand',
    linkHasStag: false,
  },
  twitch: {
    engine: 'twitch',
    table: 'twitch_streamers',
    linksTable: 'twitch_links',
    linksFk: 'twitch_streamer_id',
    sourceLabel: 'Twitch',
    nameCols: ['display_name', 'broadcaster_login'],
    profileUrlCol: 'broadcaster_url',
    emailCol: null,
    bioLinkCol: null,
    hasNotRelevant: false,
    linkBrandCol: 'brand',
    linkHasStag: true,
  },
  x: {
    engine: 'x',
    table: 'x_creators',
    linksTable: 'x_links',
    linksFk: 'x_creator_id',
    sourceLabel: 'X',
    nameCols: ['display_name', 'username'],
    profileUrlCol: 'profile_url',
    emailCol: 'contact_email',
    bioLinkCol: 'website_url',
    hasNotRelevant: false,
    linkBrandCol: 'brand',
    linkHasStag: true,
  },
  facebook: {
    engine: 'facebook',
    table: 'fb_advertisers',
    linksTable: 'fb_links',
    linksFk: 'fb_advertiser_id',
    sourceLabel: 'Facebook',
    nameCols: ['page_name'],
    profileUrlCol: 'page_url',
    emailCol: 'contact_email',
    bioLinkCol: 'page_website_url',
    hasNotRelevant: false,
    linkBrandCol: 'brand',
    linkHasStag: true,
  },
  tiktok: {
    engine: 'tiktok',
    table: 'tiktok_creators',
    linksTable: 'tiktok_links',
    linksFk: 'tiktok_creator_id',
    sourceLabel: 'TikTok',
    nameCols: ['display_name', 'username'],
    profileUrlCol: 'profile_url',
    emailCol: 'contact_email',
    bioLinkCol: 'bio_link',
    hasNotRelevant: true,
    linkBrandCol: 'brand',
    linkHasStag: true,
  },
  snapchat: {
    engine: 'snapchat',
    table: 'snapchat_creators',
    linksTable: 'snapchat_links',
    linksFk: 'snapchat_creator_id',
    sourceLabel: 'Snapchat',
    nameCols: ['display_name', 'username'],
    profileUrlCol: 'profile_url',
    emailCol: 'contact_email',
    bioLinkCol: 'bio_link',
    hasNotRelevant: true,
    linkBrandCol: 'brand',
    linkHasStag: true,
  },
  telegram: {
    engine: 'telegram',
    table: 'telegram_channels',
    linksTable: 'telegram_links',
    linksFk: 'telegram_channel_id',
    sourceLabel: 'Telegram',
    nameCols: ['title', 'username'],
    profileUrlCol: 'channel_url',
    emailCol: 'contact_email',
    bioLinkCol: null,
    hasNotRelevant: false,
    linkBrandCol: 'brand',
    linkHasStag: true,
  },
}

export const SOCIAL_ENGINES = Object.keys(ENGINE_CONFIGS) as SocialEngine[]

/** Type guard: is this `search_engine` value one of the social engines we
 *  push via the per-entity path? */
export function isSocialEngine(engine: string | null | undefined): engine is SocialEngine {
  return engine != null && engine in ENGINE_CONFIGS
}
