-- ============================================================
-- Migration: Telegram channel scraping (Phase 1 + 3)
--
-- Adds:
--   1. 'telegram' as an allowed value in scrape_queue.search_engine.
--   2. telegram_channels — one row per public Telegram channel discovered
--      via a keyword search + enriched in the SAME pass from the channel's
--      public t.me/s/{handle} SEO preview.
--   3. telegram_links — one row per affiliate/tracking URL the channel posts
--      (links in its recent messages + the channel description), resolved +
--      S-tag-parsed + checked against Monday. Mirrors snapchat_links.
--
-- Why Telegram is the PURE-HTTP path (like Kick/YouTube/Snapchat, NOT the
-- browser engines): a recon probe (2026-06-05) confirmed:
--   - DISCOVERY: lyzem.com/search?q={kw}&type=channels (a Telegram search
--     engine) returns channel handles over plain HTTP (no Cloudflare/login).
--     TGStat is Cloudflare-gated and was rejected.
--   - ENRICH: t.me/s/{handle} (Telegram's own public SEO preview) returns
--     title, description, subscriber count, and recent posts WITH their
--     outbound links — no token, no login, no JS. The casino affiliate links
--     are posted directly in messages (unlike TikTok/FB's Cloudflare-gated
--     bio hubs), so they're captured + resolvable straight away.
-- So there is NO GoLogin, NO Selenium, NO bot token, NO login wall. And
-- because enrichment is cheap HTTP, discovery + enrichment happen in ONE pass
-- (single-pass like Facebook/Snapchat — no Phase-2 job). A one-hop snowball
-- (harvest @mentions from discovered channels' posts) widens coverage since
-- casino channels cross-promote heavily. Phase 3 (runTelegramChannelAnalysis,
-- inline) scores + resolves links + checks Monday.
--
-- New-vs-known check mirrors X/TikTok: keyed on the resolved operator brand
-- AND the channel @handle.
--
-- Additive only — new tables + new enum value; every Phase 3 column is
-- nullable, so the Phase 1 insert path is unaffected.
-- ============================================================

-- 1. Allow 'telegram' alongside the existing engines.
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube', 'twitch', 'kick', 'x', 'facebook', 'tiktok', 'snapchat', 'telegram'));


-- 2. telegram_channels
create table if not exists public.telegram_channels (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Channel identity. username is the @handle (stored without the leading @);
  -- channel_url is always t.me/{username}.
  username text not null,
  channel_url text not null,

  -- Discovery context — which keyword surfaced this channel, and how
  -- ('search' = lyzem keyword search | 'snowball' = @mention of another
  -- discovered channel's post).
  discovered_from_keyword text not null,
  discovered_from_surface text,

  -- Profile metadata from the t.me/s/{handle} preview.
  title text,
  description text,
  subscriber_count bigint,

  -- Phase 3 — affiliate scoring + outreach contacts + new-vs-known verdict
  -- (mirrors snapchat_channels / tiktok_creators).
  is_likely_affiliate boolean,
  niche_score numeric(5,2),
  contact_email text,
  telegram_url text,             -- a t.me contact/DM link found in posts/bio
  discord_url text,
  is_known_on_monday boolean,
  is_new_lead_candidate boolean,

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_telegram_channels_scrape_queue_id
  on public.telegram_channels (scrape_queue_id);

create index if not exists idx_telegram_channels_username
  on public.telegram_channels (lower(username));

create index if not exists idx_telegram_channels_new_lead_candidate
  on public.telegram_channels (scrape_queue_id)
  where is_new_lead_candidate is true;


-- 3. telegram_links — affiliate/tracking links the channel posts.
-- Source 'post' (URLs in recent messages) | 'description' (URLs in the channel
-- bio). Phase 3 resolves shorteners + parses S-tags + checks Monday.
create table if not exists public.telegram_links (
  id uuid primary key default gen_random_uuid(),
  telegram_channel_id uuid not null
    references public.telegram_channels(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('post', 'description')),

  resolved_url text,
  resolved_at  timestamptz,

  s_tag       text,
  s_tag_param text,
  brand       text,

  is_known_on_monday   boolean,
  monday_match_kind    text,   -- 'item' | 'updates' | null
  monday_match_item_id text,

  created_at timestamptz not null default now()
);

create index if not exists idx_telegram_links_channel_id
  on public.telegram_links (telegram_channel_id);

create index if not exists idx_telegram_links_url
  on public.telegram_links (url);

create index if not exists idx_telegram_links_s_tag
  on public.telegram_links (lower(s_tag));


-- 4. Touch updated_at on telegram_channels updates so Phase 3 scoring
-- surfaces as recent activity.
create or replace function public.touch_telegram_channels_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_telegram_channels_updated_at on public.telegram_channels;
create trigger trg_telegram_channels_updated_at
  before update on public.telegram_channels
  for each row execute function public.touch_telegram_channels_updated_at();
