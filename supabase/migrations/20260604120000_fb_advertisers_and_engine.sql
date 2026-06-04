-- ============================================================
-- Migration: Facebook Ad Library advertiser scraping (discovery + scoring)
--
-- Adds:
--   1. 'facebook' as an allowed value in scrape_queue.search_engine.
--   2. fb_advertisers — one row per Facebook Page discovered via a
--      keyword scrape of the public Ad Library
--      (facebook.com/ads/library/?q={keyword}).
--   3. fb_links — one row per affiliate/tracking URL found in a Page's
--      ads (the ad landing destinations), resolved + S-tag-parsed + checked
--      against Monday. Mirrors x_links / kick_links / youtube_channel_links.
--
-- Why Facebook differs from the X engine it's modelled on:
--   - The lead entity is the ADVERTISER PAGE, not a creator/profile. The
--     Ad Library is ad-centric; we aggregate ads up to the Page running
--     them. Ads are evidence (counts, sample copy, landing URLs), not
--     their own lead rows — so there is no fb_ads table.
--   - Access is BROWSER, NO-LOGIN-FIRST. The public Ad Library is
--     browseable logged-out in most regions, so unlike X there is NO
--     login wall, NO is_*_logged_in flag, and NO companion login-state
--     migration. The scraper attempts logged-out and only falls back to
--     the captcha-solver checkpoint if Facebook throws an interstitial.
--
-- Discovery (fb_adlibrary_search.py, single pass) fills fb_advertisers:
--   page_id, page_name, page_url, ad_count, ad_text_sample,
--   discovered_from_keyword — and the ad landing links into fb_links
--   ('ad_landing'), parsed straight from the Ad Library search-results grid.
--   (A per-Page "Phase 2" enrichment via ?view_all_page_id= was dropped
--   2026-06-04 — see the reserved-columns note below.)
-- Scoring (runFbAdvertiserAnalysis, inline / in-app) sets: is_likely_affiliate,
--   niche_score, contact_email, telegram_url, discord_url,
--   is_known_on_monday, is_new_lead_candidate, and resolves fb_links.
--
-- A YouTube/X-style "new vs known" check applies: Facebook ad landing
-- links are often redirectors with no in-URL stag, so Phase 3 keys the
-- Monday check on the resolved operator brand AND on the page_name.
--
-- Additive only — new tables + new enum value; every scoring + reserved
-- column is nullable with no default, so the discovery insert path is clean.
-- ============================================================

-- 1. Allow 'facebook' alongside google / bing / youtube / twitch / kick / x.
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube', 'twitch', 'kick', 'x', 'facebook'));


-- 2. fb_advertisers
create table if not exists public.fb_advertisers (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Page identity. page_id is Facebook's stable numeric Page id (stored as
  -- text — it overflows int4 and we never do arithmetic on it). page_name
  -- is the advertiser's display name; page_url is the public Ad Library
  -- view for that Page (…?view_all_page_id={page_id}) or facebook.com/{id}.
  page_id text,
  page_name text not null,
  page_url text not null,

  -- Discovery context — which keyword surfaced this advertiser (from the
  -- Ad Library search grid …?q={keyword}).
  discovered_from_keyword text not null,

  -- Phase 1 — captured from the search-results grid. Pages have no bio, so
  -- ad_text_sample (concatenated/sampled ad copy) is the scorer's keyword
  -- surface. ad_count is how many of this Page's ads we saw in the search.
  ad_count int,
  ad_text_sample text,

  -- Reserved / currently unpopulated. These were a per-Page "Phase 2"
  -- enrichment (the Page's full Ad Library view via ?view_all_page_id=), which
  -- was DROPPED 2026-06-04: FB's profile id != the Ad Library page id, so that
  -- view returns no ads. Discovery now captures advertisers AND their ad
  -- landing links in one pass (see vm/fb_adlibrary_search.py), so these stay
  -- NULL. Kept nullable in case a reliable per-Page source is found later.
  total_active_ads int,
  page_category text,
  page_likes bigint,
  page_website_url text,
  page_transparency text,        -- admin country / page-created date blob
  profile_image_url text,
  about_scraped_at timestamptz,
  about_fetch_failed boolean default false,

  -- Phase 3 — affiliate scoring + outreach contacts + new-vs-known verdict
  -- (mirrors x_creators / kick_streamers / youtube_channels).
  is_likely_affiliate boolean,
  niche_score numeric(5,2),
  contact_email text,
  telegram_url text,
  discord_url text,
  is_known_on_monday boolean,
  is_new_lead_candidate boolean,

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_fb_advertisers_scrape_queue_id
  on public.fb_advertisers (scrape_queue_id);

create index if not exists idx_fb_advertisers_page_name
  on public.fb_advertisers (lower(page_name));

create index if not exists idx_fb_advertisers_page_id
  on public.fb_advertisers (page_id);

-- A partial index over advertisers worth surfacing for outreach (mirrors
-- the x_creators / youtube_channels new-lead-candidate index). Cheap — only
-- flagged rows.
create index if not exists idx_fb_advertisers_new_lead_candidate
  on public.fb_advertisers (scrape_queue_id)
  where is_new_lead_candidate is true;


-- 3. fb_links — affiliate/tracking links mined from a Page's ads.
-- Discovery writes 'ad_landing' (the ad's destination URL, l.php-unwrapped).
-- The 'ad_cta' / 'page_website' sources are reserved (the dropped per-Page
-- enrichment would have set them) but the check constraint keeps accepting
-- them. Scoring resolves shorteners + parses S-tags + checks each against
-- Monday. Mirrors x_links / kick_links / youtube_channel_links.
create table if not exists public.fb_links (
  id uuid primary key default gen_random_uuid(),
  fb_advertiser_id uuid not null
    references public.fb_advertisers(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('ad_landing', 'ad_cta', 'page_website')),

  -- Phase 3 — shortener / redirect resolution (bit.ly, the affiliate /go/
  -- redirector, FB's own l.facebook.com wrapper, etc.). Joins to the same
  -- resolver helpers the x_links + kick_links + lead s-tag pipelines use.
  resolved_url text,
  resolved_at  timestamptz,

  -- Phase 3 — S-tag parsed from the resolved URL's query params.
  -- s_tag_param is which key it came from (btag/stag/cxd/mid/affid).
  s_tag       text,
  s_tag_param text,
  brand       text,

  -- Phase 3 — new-vs-known verdict from search_s_tag_on_monday(s_tag||brand).
  is_known_on_monday   boolean,
  monday_match_kind    text,   -- 'item' | 'updates' | null
  monday_match_item_id text,

  created_at timestamptz not null default now()
);

create index if not exists idx_fb_links_advertiser_id
  on public.fb_links (fb_advertiser_id);

create index if not exists idx_fb_links_url
  on public.fb_links (url);

-- "Have we seen this S-tag?" — case-insensitive, mirrors idx_s_tags_value.
create index if not exists idx_fb_links_s_tag
  on public.fb_links (lower(s_tag));


-- 4. Touch updated_at on fb_advertisers updates so Phase 2/3 backfills
-- surface as recent activity.
create or replace function public.touch_fb_advertisers_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_fb_advertisers_updated_at on public.fb_advertisers;
create trigger trg_fb_advertisers_updated_at
  before update on public.fb_advertisers
  for each row execute function public.touch_fb_advertisers_updated_at();
