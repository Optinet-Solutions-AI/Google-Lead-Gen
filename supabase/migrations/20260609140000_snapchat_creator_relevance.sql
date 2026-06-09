-- Snapchat creator relevance gate (Phase 3 scorer-set).
--
-- Darren's 2026-06-09 report ("Snapchat - Leads Relevance"): the AU "casino
-- Australia Snapchat" and DE "Casino Germany Snapchat" scrapes discovered 35 /
-- 26 creators that are all irrelevant — a university, hotels, Ford Australia,
-- travel / lifestyle vloggers, slot-GAMEPLAY accounts — none with a casino /
-- sports affiliate tracking link. Same pattern as the YouTube + TikTok gates
-- (commits 50270ea / 3a92806).
--
-- Snapchat's only actionable affiliate tell is an outbound funnel in the bio
-- link: a directly-classified casino host, a link hub or shortener alongside
-- gambling context, or an affiliate referral code in the link path. A gambling-
-- flavoured name / bio keywords WITHOUT such a link is not an affiliate signal
-- (e.g. @rajaslots → thebigjackpot.com is a slot-gameplay site, not a funnel),
-- so the old soft 30-point niche-score threshold flagged content as affiliates.
--
-- Phase 3 scoring (lib/affiliate-detection/snapchat-scorer.ts, run inline by
-- runSnapchatCreatorAnalysis) now sets is_not_relevant = true for any scored
-- creator with NO affiliate funnel link, and only flags is_likely_affiliate
-- when such a link is present. The results table hides not-relevant creators by
-- default (a "Show all" toggle reveals them) and the affiliate / new-lead
-- counts exclude them. niche_score is still kept so the soft signals rank
-- within the full Show-all set.

alter table public.snapchat_creators
  add column if not exists is_not_relevant boolean;

comment on column public.snapchat_creators.is_not_relevant is
  'Phase 3 relevance gate: true = scored but has no outbound affiliate funnel link in the bio (a lifestyle / land-based / slot-gameplay non-affiliate), hidden from the default results view. NULL = not yet scored, or scored before 2026-06-09.';
