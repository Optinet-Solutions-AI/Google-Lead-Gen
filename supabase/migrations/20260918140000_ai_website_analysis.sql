-- Migration: AI website analysis.
--
-- Two new stages hang off the website profiles from 20260918120000:
--
--   1. TRIAGE  — a cheap, no-fetch screen over the leads that survived the
--                Monday / not-relevant / system-flag trim. Picks which sites
--                are worth paying to crawl. Writes ai_* triage columns.
--   2. CRAWL   — gpt-5-mini opens the shortlisted site and returns the
--                affiliate verdict, every brand it promotes with that brand's
--                verbatim CTA href, contacts, and the contact page.
--                Writes ai_crawl_* columns + one website_cta_links row per CTA.
--
-- Storage note (the "will this blow up the DB?" question): no page HTML is
-- kept. Only the extracted result, and only ONE row per website — a website
-- seen by 40 more scrapes updates the same row instead of adding anything.
-- The CTA links are a child table because the manual S-tag pass needs to tick
-- them off one by one and record what it found.

-- ---------------------------------------------------------------------------
-- 1. Triage + crawl columns on the profile
-- ---------------------------------------------------------------------------

alter table public.website_profiles
  -- triage (stage 1)
  add column if not exists ai_screened_at        timestamptz,
  add column if not exists ai_worth_checking     boolean,
  add column if not exists ai_screen_reason      text,
  add column if not exists ai_screen_model       text,
  -- crawl (stage 2)
  add column if not exists ai_crawl_at           timestamptz,
  add column if not exists ai_crawl_model        text,
  add column if not exists ai_crawl_status       text,   -- ok | blocked | error
  add column if not exists ai_is_affiliate       boolean,
  add column if not exists ai_affiliate_reason   text,
  add column if not exists ai_brands             jsonb,  -- [{name, cta_url}]
  add column if not exists ai_brand_count        integer,
  add column if not exists ai_cta_count          integer,
  add column if not exists ai_rooster_brands     jsonb,  -- names matching rooster_brands
  add column if not exists ai_new_brands         jsonb,  -- promoted brands we do NOT partner with
  add column if not exists ai_emails             jsonb,
  add column if not exists ai_phones             jsonb,
  add column if not exists ai_contact_page_url   text,
  add column if not exists ai_pages_opened       jsonb,
  add column if not exists ai_cost_usd           numeric(10,5),
  -- hand-off to the manual S-tag / contact pass
  add column if not exists manual_stag_status    text,   -- null | pending | in_progress | done
  add column if not exists manual_stag_at        timestamptz;

create index if not exists idx_website_profiles_ai_worth
  on public.website_profiles (ai_worth_checking, ai_screened_at desc)
  where ai_worth_checking = true;

create index if not exists idx_website_profiles_ai_affiliate
  on public.website_profiles (ai_is_affiliate)
  where ai_is_affiliate = true;

-- Queue view for the manual pass: confirmed affiliates with CTA links to walk.
create index if not exists idx_website_profiles_manual_stag
  on public.website_profiles (manual_stag_status)
  where manual_stag_status is not null;

-- ---------------------------------------------------------------------------
-- 2. One row per CTA link found on a website
-- ---------------------------------------------------------------------------

create table if not exists public.website_cta_links (
  id                 bigint generated always as identity primary key,
  profile_id         bigint      not null references public.website_profiles(id) on delete cascade,
  brand_name         text,
  -- the href exactly as it appears in the page (often a cloaked /go/... link)
  cta_url            text        not null,
  -- where that href actually lands after following the redirect chain
  resolved_url       text,
  resolved_host      text,
  redirect_hops      integer,
  -- tracker hostnames in the chain prove the traffic runs through Rooster
  is_rooster_tracker boolean     not null default false,
  tracker_host       text,
  -- does this brand match one of ours?
  is_rooster_brand   boolean     not null default false,
  unmask_status      text,       -- ok | dead | blocked | error | not_attempted
  -- the manual S-tag pass fills these in
  stag_checked_at    timestamptz,
  stag_found         text,
  stag_note          text,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  unique (profile_id, cta_url)
);

create index if not exists idx_website_cta_links_profile on public.website_cta_links (profile_id);
create index if not exists idx_website_cta_links_brand   on public.website_cta_links (brand_name);
create index if not exists idx_website_cta_links_rooster on public.website_cta_links (is_rooster_brand) where is_rooster_brand = true;
create index if not exists idx_website_cta_links_pending on public.website_cta_links (profile_id) where stag_checked_at is null;

alter table public.website_cta_links enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Settings for the two AI stages
-- ---------------------------------------------------------------------------

insert into public.system_settings (key, value) values
  ('ai_analysis_enabled',   'false'::jsonb),
  ('ai_triage_model',       '"gpt-5-mini"'::jsonb),
  ('ai_crawl_model',        '"gpt-5-mini"'::jsonb),
  -- hard ceilings so a big batch can never run away with the bill
  ('ai_crawl_daily_cap',    '150'::jsonb),
  ('ai_crawl_budget_usd',   '5'::jsonb),
  -- a crawl verdict older than this is re-done when the site shows up again
  ('ai_crawl_ttl_days',     '90'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. The candidate list: what survived the trim and still needs AI work.
--    This is the exact hand-off point between the scrape pipeline and the
--    AI pipeline, so both the scripts and any future UI read the same thing.
-- ---------------------------------------------------------------------------

create or replace function public.ai_candidates_for_job(p_job_ids uuid[])
returns table(
  profile_id        bigint,
  lead_id           bigint,
  normalized_domain text,
  url               text,
  keyword           text,
  country_code      text,
  ai_screened_at    timestamptz,
  ai_worth_checking boolean,
  ai_crawl_at       timestamptz,
  ai_is_affiliate   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (p.id)
    p.id, g.id, p.normalized_domain, g.url, g.keyword, g.country_code,
    p.ai_screened_at, p.ai_worth_checking, p.ai_crawl_at, p.ai_is_affiliate
  from public.google_lead_gen_table g
  join public.website_profiles p on p.id = g.profile_id
  where g.scrape_job_id = any(p_job_ids)
    -- the trim: nothing already on Monday, nothing marked not relevant by
    -- Monday or by us, nothing the system flagged as an obvious non-affiliate
    and p.is_on_monday = false
    and p.is_not_relevant = false
    and p.system_flag is null
    and g.url like 'http%'
  order by p.id, g.id;
$$;

grant execute on function public.ai_candidates_for_job(uuid[]) to service_role;
revoke execute on function public.ai_candidates_for_job(uuid[]) from anon, authenticated;
