-- TikTok creator relevance gate (Phase 2 worker-set).
--
-- Andrei's 2026-06-09 report: TikTok keyword scrapes (especially DE) surface a
-- lot of name-squatters — accounts merely NAMED "casino" / "online casino" (a
-- dog, a 1-video account, even a verified tax creator caught by the content
-- surface) that post nothing casino-related. On TikTok gambling content is
-- banned, so a genuine casino affiliate's ONLY tell is the bio-link funnel
-- (a hub / shortener / casino redirector). An account with zero outbound links
-- can't be an actionable affiliate lead regardless of its name.
--
-- Phase 2 enrichment (tiktok_profile_scrape.py) now sets is_not_relevant = true
-- for any creator it enriches that has NO outbound link at all (no bio_link, no
-- caption URL). The results table hides these by default (a "Show all" toggle
-- reveals them) and the affiliate counts exclude them. Keep-uncertain: any
-- creator WITH a link flows on to Phase 3 scoring unchanged — the scorer still
-- makes the affiliate call.

alter table public.tiktok_creators
  add column if not exists is_not_relevant boolean;

comment on column public.tiktok_creators.is_not_relevant is
  'Phase 2 coarse pre-filter: true = enriched but has no outbound funnel link (a name-squatter / non-affiliate), hidden from the default results view. NULL = not yet judged (un-enriched, or data enriched before 2026-06-09).';
