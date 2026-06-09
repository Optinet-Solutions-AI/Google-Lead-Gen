-- YouTube channel relevance gate (Phase 3 scorer-set).
--
-- Darren's 2026-06-09 report: YouTube AU keyword scrapes (e.g. "pokies big win
-- Australia") surface ~90% irrelevant leads — slot-/pokie-GAMEPLAY vloggers,
-- land-based-casino vlogs (Las Vegas / SkyCity / Brisbane footage), even a news
-- program (60 Minutes Australia). These aren't online-casino affiliates.
--
-- YouTube's twist vs TikTok: gambling/slots GAMEPLAY content is allowed and
-- everywhere here, so a "casino"/"pokies" name + gambling keywords is NOT an
-- affiliate signal (every gameplay vlogger trips it, and used to clear the old
-- soft 30-point niche-score threshold with zero links). The only actionable
-- tell of a casino affiliate is an outbound casino affiliate FUNNEL link in the
-- channel / recent video descriptions.
--
-- Phase 3 scoring (lib/affiliate-detection/youtube-scorer.ts, run inline by
-- runYoutubeChannelAnalysis) now sets is_not_relevant = true for any scored
-- channel with NO casino affiliate link, and only flags is_likely_affiliate
-- when such a link is present. The results table hides not-relevant channels by
-- default (a "Show all" toggle reveals them) and the affiliate / new-lead
-- counts exclude them. niche_score is still kept so the soft signals rank
-- within the full Show-all set.

alter table public.youtube_channels
  add column if not exists is_not_relevant boolean;

comment on column public.youtube_channels.is_not_relevant is
  'Phase 3 relevance gate: true = scored but has no outbound casino affiliate funnel link (a slot-gameplay vlogger / land-based casino / non-affiliate), hidden from the default results view. NULL = not yet scored, or scored before 2026-06-09.';
