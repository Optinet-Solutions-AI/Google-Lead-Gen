-- Migration: website profiles.
--
-- One row per website (normalised host). Scrapes that see a website we
-- already know no longer add a lead row — they append to an appearance log
-- (timestamp + keyword + country + url). Similar-but-not-identical hosts
-- (other subdomain, other TLD of the same brand) are linked as relations.
-- Every Monday item with a website becomes a profile, so "already on
-- Monday.com" is answered from our own table instead of 28 mirror branches
-- per lead. Verdicts carry an expiry (admin-controlled) and an obvious
-- non-affiliate can be parked under a "system flag" that skips enrichment.
--
-- Tables      : website_profiles, website_appearances, website_relations,
--               known_non_affiliate_domains
-- Lead columns: google_lead_gen_table.profile_id, .system_flag
-- Settings    : verdict_ttl_days, recency_bands_days, profile_dedupe_enabled,
--               system_flag_llm_enabled
-- Functions   : link_profile_relations, apply_db_system_flags,
--               set_profile_system_flag, refresh_profiles_from_monday,
--               propagate_profile_monday_to_leads,
--               mark_monday_duplicates_for_job (v2, profile-first),
--               sync_lead_to_profile (trigger), complete_scrape_job (v2),
--               advance_enrichment_chain (system_flag gate),
--               search_website_on_monday_all, get_monday_mirror_freshness
--
-- Backfill of existing rows lives in 20260918120100_website_profiles_backfill.sql.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.website_profiles (
  id                          bigint generated always as identity primary key,
  normalized_domain           text        not null unique,
  registered_domain           text        not null,
  brand_stem                  text,
  display_name                text,
  -- 'scrape' when a SERP result created it, 'monday' when the mirror did.
  source                      text        not null default 'scrape',
  -- The one lead row that represents this website in the leads table.
  first_lead_id               bigint      references public.google_lead_gen_table(id) on delete set null,
  first_seen_at               timestamptz,
  last_seen_at                timestamptz,
  appearance_count            integer     not null default 0,
  -- Monday.com
  is_on_monday                boolean     not null default false,
  monday_board                text,
  monday_item_id              text,
  monday_match_kind           text,
  monday_matched_at           timestamptz,
  monday_item_synced_at       timestamptz,
  monday_overridden_at        timestamptz,
  -- Durable negatives
  is_not_relevant             boolean     not null default false,
  not_relevant_source         text,
  not_relevant_at             timestamptz,
  system_flag                 text,
  system_flag_source          text,
  system_flag_reason          text,
  system_flag_at              timestamptz,
  system_flag_checked_at      timestamptz,
  system_flag_llm_checked_at  timestamptz,
  system_flag_overridden_at   timestamptz,
  -- Verdicts (latest wins; an override always wins)
  is_affiliate                boolean,
  affiliate_confidence        text,
  affiliate_score             integer,
  affiliate_checked_at        timestamptz,
  affiliate_source            text,
  is_affiliate_overridden_at  timestamptz,
  is_rooster_partner          boolean,
  brand                       text,
  rooster_brands              jsonb,
  rooster_checked_at          timestamptz,
  rooster_source              text,
  is_rooster_overridden_at    timestamptz,
  has_contact_details         boolean,
  contact_checked_at          timestamptz,
  has_s_tags                  boolean,
  s_tags_checked_at           timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists idx_website_profiles_registered   on public.website_profiles (registered_domain);
create index if not exists idx_website_profiles_brand_stem   on public.website_profiles (brand_stem) where brand_stem is not null;
create index if not exists idx_website_profiles_last_seen    on public.website_profiles (last_seen_at desc nulls last);
create index if not exists idx_website_profiles_monday_item  on public.website_profiles (monday_item_id) where monday_item_id is not null;
create index if not exists idx_website_profiles_system_flag  on public.website_profiles (system_flag) where system_flag is not null;
create index if not exists idx_website_profiles_unchecked    on public.website_profiles (created_at desc)
  where system_flag is null and system_flag_llm_checked_at is null and system_flag_overridden_at is null;

alter table public.website_profiles enable row level security;

create table if not exists public.website_appearances (
  id                    bigint generated always as identity primary key,
  profile_id            bigint      not null references public.website_profiles(id) on delete cascade,
  lead_id               bigint      references public.google_lead_gen_table(id) on delete set null,
  scrape_job_id         uuid,
  batch_id              bigint,
  keyword               text,
  country_code          text,
  search_engine         text,
  result_type           text,
  url                   text,
  page_number           integer,
  position_on_page      integer,
  overall_position      integer,
  seen_on               text,
  serp_screenshot_path  text,
  -- true when this sighting is the one that created the website's lead row
  created_lead          boolean     not null default false,
  seen_at               timestamptz not null default now()
);

create index if not exists idx_website_appearances_profile_seen on public.website_appearances (profile_id, seen_at desc);
create index if not exists idx_website_appearances_job          on public.website_appearances (scrape_job_id);
create index if not exists idx_website_appearances_batch        on public.website_appearances (batch_id);
create index if not exists idx_website_appearances_lead         on public.website_appearances (lead_id) where lead_id is not null;

alter table public.website_appearances enable row level security;

create table if not exists public.website_relations (
  id                  bigint generated always as identity primary key,
  profile_id          bigint      not null references public.website_profiles(id) on delete cascade,
  related_profile_id  bigint      not null references public.website_profiles(id) on delete cascade,
  -- same_registered_domain (other subdomain) | same_brand_stem (other TLD) | manual
  relation            text        not null,
  confidence          numeric(3,2) not null default 0.50,
  created_at          timestamptz not null default now(),
  constraint website_relations_distinct check (profile_id <> related_profile_id),
  constraint website_relations_ordered  check (profile_id < related_profile_id),
  unique (profile_id, related_profile_id, relation)
);

create index if not exists idx_website_relations_related on public.website_relations (related_profile_id);

alter table public.website_relations enable row level security;

-- Own-DB knowledge of websites that are obviously not affiliates. A lookup
-- table, not a pattern list — extend it from the admin side as we learn.
create table if not exists public.known_non_affiliate_domains (
  registered_domain text        primary key,
  category          text        not null,
  note              text,
  added_by          text        not null default 'seed',
  added_at          timestamptz not null default now()
);

alter table public.known_non_affiliate_domains enable row level security;

insert into public.known_non_affiliate_domains (registered_domain, category) values
  -- platforms / big tech
  ('google.com','platform'), ('youtube.com','platform'), ('apple.com','platform'), ('microsoft.com','platform'),
  ('amazon.com','platform'), ('amazon.co.uk','platform'), ('amazon.de','platform'), ('bing.com','search_engine'),
  ('yahoo.com','search_engine'), ('duckduckgo.com','search_engine'), ('cloudflare.com','platform'),
  ('wordpress.com','platform'), ('wordpress.org','platform'), ('blogspot.com','platform'), ('github.com','platform'),
  ('stackoverflow.com','platform'), ('imdb.com','platform'), ('netflix.com','platform'), ('ebay.com','platform'),
  ('shopify.com','platform'), ('wix.com','platform'), ('squarespace.com','platform'), ('godaddy.com','platform'),
  ('mozilla.org','platform'), ('adobe.com','platform'), ('oracle.com','platform'), ('ibm.com','platform'),
  ('salesforce.com','platform'), ('hubspot.com','platform'), ('mailchimp.com','platform'), ('zoom.us','platform'),
  ('slack.com','platform'), ('notion.so','platform'), ('trello.com','platform'), ('atlassian.com','platform'),
  ('dropbox.com','platform'), ('canva.com','platform'), ('archive.org','platform'),
  -- reference
  ('wikipedia.org','reference'), ('wikimedia.org','reference'), ('britannica.com','reference'), ('statista.com','reference'),
  ('investopedia.com','reference'), ('quora.com','reference'), ('trustpilot.com','reference'), ('glassdoor.com','reference'),
  ('indeed.com','reference'), ('crunchbase.com','reference'), ('similarweb.com','reference'), ('semrush.com','tool'),
  ('ahrefs.com','tool'),
  -- news
  ('bbc.co.uk','news'), ('bbc.com','news'), ('theguardian.com','news'), ('nytimes.com','news'), ('cnn.com','news'),
  ('reuters.com','news'), ('forbes.com','news'), ('bloomberg.com','news'), ('dailymail.co.uk','news'), ('telegraph.co.uk','news'),
  ('independent.co.uk','news'), ('mirror.co.uk','news'), ('thesun.co.uk','news'), ('express.co.uk','news'), ('metro.co.uk','news'),
  ('standard.co.uk','news'), ('sky.com','news'), ('itv.com','news'), ('channel4.com','news'), ('techcrunch.com','news'),
  ('wired.com','news'), ('theverge.com','news'), ('spiegel.de','news'), ('bild.de','news'), ('zeit.de','news'), ('faz.net','news'),
  ('welt.de','news'), ('sueddeutsche.de','news'), ('lemonde.fr','news'), ('lefigaro.fr','news'), ('elpais.com','news'),
  ('elmundo.es','news'), ('corriere.it','news'), ('repubblica.it','news'), ('nrk.no','news'), ('vg.no','news'), ('dn.se','news'),
  ('aftonbladet.se','news'), ('expressen.se','news'), ('nzz.ch','news'), ('srf.ch','news'), ('20min.ch','news'), ('orf.at','news'),
  ('derstandard.at','news'), ('krone.at','news'), ('rte.ie','news'), ('irishtimes.com','news'), ('independent.ie','news'),
  ('smh.com.au','news'), ('abc.net.au','news'), ('news.com.au','news'), ('nzherald.co.nz','news'), ('stuff.co.nz','news'),
  ('cbc.ca','news'), ('globalnews.ca','news'), ('nu.nl','news'), ('telegraaf.nl','news'), ('hs.fi','news'), ('yle.fi','news'),
  ('dr.dk','news'), ('bt.dk','news'),
  -- government / regulators / responsible gambling
  ('gov.uk','government'), ('europa.eu','government'), ('gamblingcommission.gov.uk','regulator'), ('mga.org.mt','regulator'),
  ('spelinspektionen.se','regulator'), ('kansspelautoriteit.nl','regulator'), ('adm.gov.it','regulator'), ('anj.fr','regulator'),
  ('gluecksspiel-behoerde.de','regulator'), ('spillemyndigheden.dk','regulator'), ('lotteritilsynet.no','regulator'),
  ('begambleaware.org','responsible_gambling'), ('gamcare.org.uk','responsible_gambling'), ('gamblersanonymous.org','responsible_gambling'),
  ('gamstop.co.uk','responsible_gambling'), ('gamblingtherapy.org','responsible_gambling'),
  -- payments
  ('paypal.com','payment'), ('stripe.com','payment'), ('visa.com','payment'), ('mastercard.com','payment'), ('skrill.com','payment'),
  ('neteller.com','payment'), ('trustly.com','payment'), ('klarna.com','payment'), ('paysafecard.com','payment'), ('revolut.com','payment')
on conflict (registered_domain) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Lead columns
-- ---------------------------------------------------------------------------

alter table public.google_lead_gen_table
  add column if not exists profile_id  bigint references public.website_profiles(id) on delete set null,
  add column if not exists system_flag text;

create index if not exists idx_leads_profile_id  on public.google_lead_gen_table (profile_id) where profile_id is not null;
create index if not exists idx_leads_system_flag on public.google_lead_gen_table (system_flag) where system_flag is not null;

-- ---------------------------------------------------------------------------
-- 3. Settings (admin control)
-- ---------------------------------------------------------------------------

insert into public.system_settings (key, value) values
  ('verdict_ttl_days',        '{"affiliate": 90, "rooster": 60, "contact": 180, "stags": 90}'::jsonb),
  ('recency_bands_days',      '{"fresh": 7, "recent": 30, "aging": 90}'::jsonb),
  ('profile_dedupe_enabled',  'true'::jsonb),
  ('system_flag_llm_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Relations: link a profile to hosts that share its registered domain
--    (subdomain variants) or its brand stem (TLD variants).
-- ---------------------------------------------------------------------------

create or replace function public.link_profile_relations(p_profile_ids bigint[])
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
  v_m integer := 0;
begin
  if p_profile_ids is null or array_length(p_profile_ids, 1) is null then
    return 0;
  end if;

  -- Other hosts under the same registered domain. Social platforms and
  -- domains with more than 50 hosts (blog farms) are not linked — the
  -- relation would say nothing.
  insert into public.website_relations (profile_id, related_profile_id, relation, confidence)
  select distinct least(a.id, b.id), greatest(a.id, b.id), 'same_registered_domain', 0.80
  from public.website_profiles a
  join public.website_profiles b
    on b.registered_domain = a.registered_domain and b.id <> a.id
  where a.id = any(p_profile_ids)
    and a.registered_domain <> ''
    and not is_social_host(a.registered_domain)
    and (select count(*) from public.website_profiles c where c.registered_domain = a.registered_domain) <= 50
  on conflict do nothing;
  get diagnostics v_n = row_count;

  -- Same brand stem on another TLD (casinoreviews.com ↔ casinoreviews.co.uk).
  insert into public.website_relations (profile_id, related_profile_id, relation, confidence)
  select distinct least(a.id, b.id), greatest(a.id, b.id), 'same_brand_stem', 0.50
  from public.website_profiles a
  join public.website_profiles b
    on b.brand_stem = a.brand_stem
   and b.registered_domain <> a.registered_domain
  where a.id = any(p_profile_ids)
    and coalesce(a.brand_stem, '') <> ''
    and length(a.brand_stem) >= 12
    and (select count(*) from public.website_profiles c where c.brand_stem = a.brand_stem) <= 50
  on conflict do nothing;
  get diagnostics v_m = row_count;

  return v_n + v_m;
end;
$$;

grant execute on function public.link_profile_relations(bigint[]) to service_role;
revoke execute on function public.link_profile_relations(bigint[]) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. System flags from our own DB: operator denylist, social platforms,
--    known non-affiliate list. Mirrors onto the website's lead rows and
--    cancels enrichment that has not started. p_profile_ids null = every
--    profile not yet flagged.
-- ---------------------------------------------------------------------------

create or replace function public.apply_db_system_flags(p_profile_ids bigint[] default null)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_flagged bigint[];
begin
  perform set_config('app.skip_lead_profile_sync', '1', true);

  with cand as (
    select p.id, p.normalized_domain as nd, p.registered_domain as rd
    from public.website_profiles p
    where (p_profile_ids is null or p.id = any(p_profile_ids))
      and p.system_flag is null
      and p.system_flag_overridden_at is null
  ),
  judged as (
    select c.id,
           d.host_suffix,
           is_social_host(c.rd) as social,
           k.category
    from cand c
    left join lateral (
      select host_suffix from public.operator_domains_denylist d
      where c.nd = d.host_suffix or c.nd like '%.' || d.host_suffix
      limit 1
    ) d on true
    left join public.known_non_affiliate_domains k on k.registered_domain = c.rd
  ),
  flagged as (
    select id,
           case when host_suffix is not null then 'operator_site'
                when social then 'social_platform'
                else category end as flag,
           case when host_suffix is not null then 'operator_denylist'
                when social then 'social_host'
                else 'known_list' end as src,
           case when host_suffix is not null then 'Casino operator domain list: ' || host_suffix
                when social then 'Social / video platform host'
                else 'Known non-affiliate website (' || category || ')' end as reason
    from judged
    where host_suffix is not null or social or category is not null
  ),
  upd as (
    update public.website_profiles p
    set system_flag            = f.flag,
        system_flag_source     = f.src,
        system_flag_reason     = f.reason,
        system_flag_at         = v_now,
        system_flag_checked_at = v_now,
        is_not_relevant        = p.is_not_relevant or f.flag = 'operator_site',
        not_relevant_source    = coalesce(p.not_relevant_source, case when f.flag = 'operator_site' then 'operator_denylist' end),
        not_relevant_at        = coalesce(p.not_relevant_at,     case when f.flag = 'operator_site' then v_now end),
        updated_at             = v_now
    from flagged f
    where p.id = f.id
    returning p.id
  )
  select coalesce(array_agg(id), '{}'::bigint[]) into v_flagged from upd;

  -- Stamp the ones we looked at and left alone, so the LLM pass knows the
  -- DB pass already ran.
  update public.website_profiles p
  set system_flag_checked_at = v_now
  where (p_profile_ids is null or p.id = any(p_profile_ids))
    and p.system_flag is null
    and p.system_flag_checked_at is null;

  if array_length(v_flagged, 1) is null then
    return 0;
  end if;

  update public.google_lead_gen_table g
  set system_flag            = p.system_flag,
      is_not_relevant        = g.is_not_relevant or p.system_flag = 'operator_site',
      not_relevant_marked_by = coalesce(g.not_relevant_marked_by, case when p.system_flag = 'operator_site' then 'operator_denylist' end),
      not_relevant_marked_at = coalesce(g.not_relevant_marked_at, case when p.system_flag = 'operator_site' then v_now end)
  from public.website_profiles p
  where g.profile_id = p.id
    and p.id = any(v_flagged)
    and g.system_flag is distinct from p.system_flag;

  delete from public.enrichment_fetch_queue q
  using public.google_lead_gen_table g
  where q.lead_id = g.id
    and g.profile_id = any(v_flagged)
    and q.status = 'pending';

  return array_length(v_flagged, 1);
end;
$$;

grant execute on function public.apply_db_system_flags(bigint[]) to service_role;
revoke execute on function public.apply_db_system_flags(bigint[]) from anon, authenticated;

-- Set (or clear, with p_flag null) one website's system flag. Used by the
-- OpenAI pass and by operators. Clearing records an override so no automatic
-- pass re-applies it.
create or replace function public.set_profile_system_flag(
  p_profile_id bigint,
  p_flag       text,
  p_source     text,
  p_reason     text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  perform set_config('app.skip_lead_profile_sync', '1', true);

  update public.website_profiles p
  set system_flag                = p_flag,
      system_flag_source         = case when p_flag is null then null else p_source end,
      system_flag_reason         = case when p_flag is null then null else p_reason end,
      system_flag_at             = case when p_flag is null then null else v_now end,
      system_flag_checked_at     = v_now,
      system_flag_llm_checked_at = case when p_source = 'openai' then v_now else p.system_flag_llm_checked_at end,
      system_flag_overridden_at  = case when p_flag is null then v_now else p.system_flag_overridden_at end,
      updated_at                 = v_now
  where p.id = p_profile_id;

  update public.google_lead_gen_table g
  set system_flag = p_flag
  where g.profile_id = p_profile_id
    and g.system_flag is distinct from p_flag;

  if p_flag is not null then
    delete from public.enrichment_fetch_queue q
    using public.google_lead_gen_table g
    where q.lead_id = g.id
      and g.profile_id = p_profile_id
      and q.status = 'pending';
  end if;
end;
$$;

grant execute on function public.set_profile_system_flag(bigint, text, text, text) to service_role;
revoke execute on function public.set_profile_system_flag(bigint, text, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Monday → profiles. Runs after every mirror sync. Every Monday item with
--    a website (or a domain as its title) becomes / updates a profile; other
--    profiles pick up registered-domain, brand-stem and updates-mention
--    matches. A profile with a manual Monday override is left alone.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_profiles_from_monday()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now         timestamptz := now();
  v_exact       integer := 0;
  v_exact_name  integer := 0;
  v_registered  integer := 0;
  v_stem        integer := 0;
  v_mentioned   integer := 0;
  v_mstem       integer := 0;
  v_created     integer := 0;
  v_before      integer;
begin
  select count(*) into v_before from public.website_profiles;

  -- Tier 1: exact website. Board priority mirrors search_website_on_monday.
  with items as (
    select 'affiliates'::text as board, 1 as prio, monday_item_id, name, website_normalized as w, synced_at, monday_updated_at
      from public.affiliates_table where coalesce(website_normalized, '') <> ''
    union all
    select 'leads', 2, monday_item_id, name, website_normalized, synced_at, monday_updated_at
      from public.leads_table where coalesce(website_normalized, '') <> ''
    union all
    select 'not_relevant_leads', 3, monday_item_id, name, website_normalized, synced_at, monday_updated_at
      from public.not_relevant_leads_table where coalesce(website_normalized, '') <> ''
    union all
    select 'email_undelivered_leads', 4, monday_item_id, name, website_normalized, synced_at, monday_updated_at
      from public.email_undelivered_leads_table where coalesce(website_normalized, '') <> ''
  ),
  best as (
    select distinct on (w) * from items order by w, prio, monday_updated_at desc nulls last
  ),
  up as (
    insert into public.website_profiles (
      normalized_domain, registered_domain, brand_stem, display_name, source,
      is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_matched_at, monday_item_synced_at,
      is_not_relevant, not_relevant_source, not_relevant_at
    )
    select b.w, coalesce(registered_domain(b.w), b.w), brand_stem(b.w), b.name, 'monday',
           true, b.board, b.monday_item_id, 'exact', v_now, b.synced_at,
           (b.board = 'not_relevant_leads'),
           case when b.board = 'not_relevant_leads' then 'monday' end,
           case when b.board = 'not_relevant_leads' then coalesce(b.monday_updated_at, v_now) end
    from best b
    on conflict (normalized_domain) do update
      set is_on_monday          = true,
          monday_board          = excluded.monday_board,
          monday_item_id        = excluded.monday_item_id,
          monday_match_kind     = 'exact',
          monday_matched_at     = v_now,
          monday_item_synced_at = excluded.monday_item_synced_at,
          display_name          = coalesce(website_profiles.display_name, excluded.display_name),
          is_not_relevant       = website_profiles.is_not_relevant or excluded.is_not_relevant,
          not_relevant_source   = coalesce(website_profiles.not_relevant_source, excluded.not_relevant_source),
          not_relevant_at       = coalesce(website_profiles.not_relevant_at, excluded.not_relevant_at),
          updated_at            = v_now
      where website_profiles.monday_overridden_at is null
    returning 1
  )
  select count(*) into v_exact from up;

  -- Tier 2: the item title is a bare domain and the website column is empty.
  with items as (
    select 'affiliates'::text as board, 1 as prio, monday_item_id, name, normalize_domain(name) as w, synced_at, monday_updated_at
      from public.affiliates_table
      where coalesce(website_normalized, '') = '' and name is not null and position('/' in name) = 0 and position('.' in name) > 0 and position(' ' in trim(name)) = 0
    union all
    select 'leads', 2, monday_item_id, name, normalize_domain(name), synced_at, monday_updated_at
      from public.leads_table
      where coalesce(website_normalized, '') = '' and name is not null and position('/' in name) = 0 and position('.' in name) > 0 and position(' ' in trim(name)) = 0
    union all
    select 'not_relevant_leads', 3, monday_item_id, name, normalize_domain(name), synced_at, monday_updated_at
      from public.not_relevant_leads_table
      where coalesce(website_normalized, '') = '' and name is not null and position('/' in name) = 0 and position('.' in name) > 0 and position(' ' in trim(name)) = 0
    union all
    select 'email_undelivered_leads', 4, monday_item_id, name, normalize_domain(name), synced_at, monday_updated_at
      from public.email_undelivered_leads_table
      where coalesce(website_normalized, '') = '' and name is not null and position('/' in name) = 0 and position('.' in name) > 0 and position(' ' in trim(name)) = 0
  ),
  best as (
    select distinct on (w) * from items where coalesce(w, '') <> '' order by w, prio, monday_updated_at desc nulls last
  ),
  up as (
    insert into public.website_profiles (
      normalized_domain, registered_domain, brand_stem, display_name, source,
      is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_matched_at, monday_item_synced_at,
      is_not_relevant, not_relevant_source, not_relevant_at
    )
    select b.w, coalesce(registered_domain(b.w), b.w), brand_stem(b.w), b.name, 'monday',
           true, b.board, b.monday_item_id, 'exact_name', v_now, b.synced_at,
           (b.board = 'not_relevant_leads'),
           case when b.board = 'not_relevant_leads' then 'monday' end,
           case when b.board = 'not_relevant_leads' then coalesce(b.monday_updated_at, v_now) end
    from best b
    on conflict (normalized_domain) do update
      set is_on_monday          = true,
          monday_board          = excluded.monday_board,
          monday_item_id        = excluded.monday_item_id,
          monday_match_kind     = 'exact_name',
          monday_matched_at     = v_now,
          monday_item_synced_at = excluded.monday_item_synced_at,
          display_name          = coalesce(website_profiles.display_name, excluded.display_name),
          is_not_relevant       = website_profiles.is_not_relevant or excluded.is_not_relevant,
          not_relevant_source   = coalesce(website_profiles.not_relevant_source, excluded.not_relevant_source),
          not_relevant_at       = coalesce(website_profiles.not_relevant_at, excluded.not_relevant_at),
          updated_at            = v_now
      where website_profiles.monday_overridden_at is null
        and website_profiles.monday_match_kind is distinct from 'exact'
    returning 1
  )
  select count(*) into v_exact_name from up;

  select count(*) - v_before into v_created from public.website_profiles;

  -- New Monday-born profiles need their relations and DB flags too.
  perform public.link_profile_relations(array(
    select id from public.website_profiles where source = 'monday' and created_at >= v_now
  ));
  perform public.apply_db_system_flags(array(
    select id from public.website_profiles where source = 'monday' and created_at >= v_now
  ));

  -- Tier 3: another host of a registered domain that Monday lists.
  with src as (
    select distinct on (registered_domain) registered_domain, monday_board, monday_item_id, monday_item_synced_at
    from public.website_profiles
    where is_on_monday and monday_match_kind in ('exact', 'exact_name') and registered_domain <> ''
      and not is_social_host(registered_domain)
    order by registered_domain, case monday_board when 'affiliates' then 1 when 'leads' then 2 when 'not_relevant_leads' then 3 else 4 end
  ),
  up as (
    update public.website_profiles p
    set is_on_monday = true, monday_board = s.monday_board, monday_item_id = s.monday_item_id,
        monday_match_kind = 'registered', monday_matched_at = v_now, monday_item_synced_at = s.monday_item_synced_at,
        is_not_relevant     = p.is_not_relevant or coalesce(s.monday_board = 'not_relevant_leads', false),
        not_relevant_source = coalesce(p.not_relevant_source, case when s.monday_board = 'not_relevant_leads' then 'monday' end),
        not_relevant_at     = coalesce(p.not_relevant_at,     case when s.monday_board = 'not_relevant_leads' then v_now end),
        updated_at = v_now
    from src s
    where p.registered_domain = s.registered_domain
      and p.monday_overridden_at is null
      and (p.is_on_monday is not true or p.monday_match_kind not in ('exact', 'exact_name', 'registered'))
    returning 1
  )
  select count(*) into v_registered from up;

  -- Tier 4: same brand stem on another TLD.
  with src as (
    select distinct on (brand_stem) brand_stem, registered_domain, monday_board, monday_item_id, monday_item_synced_at
    from public.website_profiles
    where is_on_monday and monday_match_kind in ('exact', 'exact_name') and length(coalesce(brand_stem, '')) >= 12
    order by brand_stem, case monday_board when 'affiliates' then 1 when 'leads' then 2 when 'not_relevant_leads' then 3 else 4 end
  ),
  up as (
    update public.website_profiles p
    set is_on_monday = true, monday_board = s.monday_board, monday_item_id = s.monday_item_id,
        monday_match_kind = 'brand_stem', monday_matched_at = v_now, monday_item_synced_at = s.monday_item_synced_at,
        is_not_relevant     = p.is_not_relevant or coalesce(s.monday_board = 'not_relevant_leads', false),
        not_relevant_source = coalesce(p.not_relevant_source, case when s.monday_board = 'not_relevant_leads' then 'monday' end),
        not_relevant_at     = coalesce(p.not_relevant_at,     case when s.monday_board = 'not_relevant_leads' then v_now end),
        updated_at = v_now
    from src s
    where p.brand_stem = s.brand_stem
      and p.registered_domain <> s.registered_domain
      and p.monday_overridden_at is null
      and p.is_on_monday is not true
    returning 1
  )
  select count(*) into v_stem from up;

  -- Tier 5: our registered domain appears in an item's updates.
  with cand as (
    select p.id, p.registered_domain as rd
    from public.website_profiles p
    where p.is_on_monday is not true and p.monday_overridden_at is null and p.registered_domain <> ''
      and not is_social_host(p.registered_domain)
  ),
  hit as (
    select c.id, m.board, m.item_id, m.synced_at
    from cand c
    cross join lateral (
      (select 'affiliates'::text as board, i.monday_item_id as item_id, i.synced_at
         from public.affiliates_updates_table u join public.affiliates_table i on i.monday_item_id = u.monday_item_id
        where u.body_domains @> array[c.rd] limit 1)
      union all
      (select 'leads', i.monday_item_id, i.synced_at
         from public.leads_updates_table u join public.leads_table i on i.monday_item_id = u.monday_item_id
        where u.body_domains @> array[c.rd] limit 1)
      union all
      (select 'not_relevant_leads', i.monday_item_id, i.synced_at
         from public.not_relevant_leads_updates_table u join public.not_relevant_leads_table i on i.monday_item_id = u.monday_item_id
        where u.body_domains @> array[c.rd] limit 1)
      union all
      (select 'email_undelivered_leads', i.monday_item_id, i.synced_at
         from public.email_undelivered_leads_updates_table u join public.email_undelivered_leads_table i on i.monday_item_id = u.monday_item_id
        where u.body_domains @> array[c.rd] limit 1)
      limit 1
    ) m
  ),
  up as (
    update public.website_profiles p
    set is_on_monday = true, monday_board = h.board, monday_item_id = h.item_id,
        monday_match_kind = 'mentioned_in_updates', monday_matched_at = v_now, monday_item_synced_at = h.synced_at,
        updated_at = v_now
    from hit h
    where p.id = h.id
    returning 1
  )
  select count(*) into v_mentioned from up;

  -- Tier 6: our brand stem appears in an item's updates (TLD variant of a mentioned domain).
  with cand as (
    select p.id, p.brand_stem as s
    from public.website_profiles p
    where p.is_on_monday is not true and p.monday_overridden_at is null and length(coalesce(p.brand_stem, '')) >= 12
  ),
  hit as (
    select c.id, m.board, m.item_id, m.synced_at
    from cand c
    cross join lateral (
      (select 'affiliates'::text as board, i.monday_item_id as item_id, i.synced_at
         from public.affiliates_updates_table u join public.affiliates_table i on i.monday_item_id = u.monday_item_id
        where u.body_stems @> array[c.s] limit 1)
      union all
      (select 'leads', i.monday_item_id, i.synced_at
         from public.leads_updates_table u join public.leads_table i on i.monday_item_id = u.monday_item_id
        where u.body_stems @> array[c.s] limit 1)
      union all
      (select 'not_relevant_leads', i.monday_item_id, i.synced_at
         from public.not_relevant_leads_updates_table u join public.not_relevant_leads_table i on i.monday_item_id = u.monday_item_id
        where u.body_stems @> array[c.s] limit 1)
      union all
      (select 'email_undelivered_leads', i.monday_item_id, i.synced_at
         from public.email_undelivered_leads_updates_table u join public.email_undelivered_leads_table i on i.monday_item_id = u.monday_item_id
        where u.body_stems @> array[c.s] limit 1)
      limit 1
    ) m
  ),
  up as (
    update public.website_profiles p
    set is_on_monday = true, monday_board = h.board, monday_item_id = h.item_id,
        monday_match_kind = 'mentioned_in_updates_stem', monday_matched_at = v_now, monday_item_synced_at = h.synced_at,
        updated_at = v_now
    from hit h
    where p.id = h.id
    returning 1
  )
  select count(*) into v_mstem from up;

  -- Everything else has now been checked against a fresh mirror: stamp it so
  -- scrape-time matching trusts the profile instead of searching again.
  update public.website_profiles
  set monday_matched_at = v_now
  where monday_overridden_at is null
    and (monday_matched_at is null or monday_matched_at < v_now);

  return jsonb_build_object(
    'profiles_created', v_created,
    'exact', v_exact, 'exact_name', v_exact_name, 'registered', v_registered,
    'brand_stem', v_stem, 'mentioned_in_updates', v_mentioned, 'mentioned_in_updates_stem', v_mstem
  );
end;
$$;

grant execute on function public.refresh_profiles_from_monday() to service_role;
revoke execute on function public.refresh_profiles_from_monday() from anon, authenticated;

-- Push the profile's Monday verdict down to lead rows that disagree with it
-- (leads with a manual Monday override are left alone).
create or replace function public.propagate_profile_monday_to_leads()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_n   integer := 0;
begin
  perform set_config('app.skip_lead_profile_sync', '1', true);

  update public.google_lead_gen_table g
  set is_on_monday           = p.is_on_monday,
      monday_board           = p.monday_board,
      monday_item_id         = p.monday_item_id,
      monday_match_kind      = p.monday_match_kind,
      monday_checked_at      = v_now,
      is_not_relevant        = g.is_not_relevant or (p.is_not_relevant and p.not_relevant_source = 'monday'),
      not_relevant_marked_by = coalesce(g.not_relevant_marked_by, case when p.is_not_relevant and p.not_relevant_source = 'monday' then 'monday_sync' end),
      not_relevant_marked_at = coalesce(g.not_relevant_marked_at, case when p.is_not_relevant and p.not_relevant_source = 'monday' then v_now end),
      system_flag            = coalesce(g.system_flag, p.system_flag)
  from public.website_profiles p
  where g.profile_id = p.id
    and g.monday_overridden_at is null
    and p.monday_matched_at is not null
    and (
      g.is_on_monday   is distinct from p.is_on_monday
      or g.monday_board   is distinct from p.monday_board
      or g.monday_item_id is distinct from p.monday_item_id
      or (p.is_not_relevant and p.not_relevant_source = 'monday' and not g.is_not_relevant)
      or (g.system_flag is null and p.system_flag is not null)
    );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

grant execute on function public.propagate_profile_monday_to_leads() to service_role;
revoke execute on function public.propagate_profile_monday_to_leads() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Scrape-time Monday check, v2: answer from the profile. Only a profile
--    that has never been compared with the mirror (or a lead without a
--    profile) searches the mirror, and that result is cached on the profile.
-- ---------------------------------------------------------------------------

create or replace function public.mark_monday_duplicates_for_job(p_job_id uuid)
returns table(checked integer, matched integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_checked integer := 0;
  v_matched integer := 0;
begin
  perform set_config('app.skip_lead_profile_sync', '1', true);

  -- A. profiles never compared with the mirror: search once, remember.
  with todo as (
    select distinct p.id, p.normalized_domain
    from public.google_lead_gen_table g
    join public.website_profiles p on p.id = g.profile_id
    where g.scrape_job_id = p_job_id
      and p.monday_matched_at is null
      and p.monday_overridden_at is null
  ),
  found as (
    select t.id, m.board, m.item_id, m.match_kind
    from todo t
    left join lateral (select * from public.search_website_on_monday(t.normalized_domain) limit 1) m on true
  )
  update public.website_profiles p
  set is_on_monday        = (f.item_id is not null),
      monday_board        = f.board,
      monday_item_id      = f.item_id,
      monday_match_kind   = f.match_kind,
      monday_matched_at   = v_now,
      is_not_relevant     = p.is_not_relevant or coalesce(f.board = 'not_relevant_leads', false),
      not_relevant_source = coalesce(p.not_relevant_source, case when f.board = 'not_relevant_leads' then 'monday' end),
      not_relevant_at     = coalesce(p.not_relevant_at,     case when f.board = 'not_relevant_leads' then v_now end),
      updated_at          = v_now
  from found f
  where p.id = f.id;

  -- B. copy the profile verdict onto this job's leads. Leads without a
  --    profile (unparseable host) still ask the mirror directly.
  with res as (
    select g.id as lead_id, p.is_on_monday as on_m, p.monday_board as board, p.monday_item_id as item_id, p.monday_match_kind as kind
    from public.google_lead_gen_table g
    join public.website_profiles p on p.id = g.profile_id
    where g.scrape_job_id = p_job_id
      and g.monday_overridden_at is null
    union all
    select g.id, (m.item_id is not null), m.board, m.item_id, m.match_kind
    from public.google_lead_gen_table g
    left join lateral (
      select * from public.search_website_on_monday(normalize_domain(coalesce(g.domain, g.url))) limit 1
    ) m on true
    where g.scrape_job_id = p_job_id
      and g.monday_overridden_at is null
      and g.profile_id is null
  ),
  upd as (
    update public.google_lead_gen_table g
    set is_on_monday      = coalesce(r.on_m, false),
        monday_board      = r.board,
        monday_item_id    = r.item_id,
        monday_match_kind = r.kind,
        monday_checked_at = v_now,
        is_not_relevant   = case when r.board = 'not_relevant_leads' then true else g.is_not_relevant end,
        not_relevant_marked_at = case when r.board = 'not_relevant_leads' and g.not_relevant_marked_at is null then v_now else g.not_relevant_marked_at end,
        not_relevant_marked_by = case when r.board = 'not_relevant_leads' and g.not_relevant_marked_by is null then 'monday_sync' else g.not_relevant_marked_by end
    from res r
    where g.id = r.lead_id
    returning g.is_on_monday
  )
  select count(*)::integer, count(*) filter (where is_on_monday)::integer
    into v_checked, v_matched
  from upd;

  return query select v_checked, v_matched;
end;
$$;

grant execute on function public.mark_monday_duplicates_for_job(uuid) to service_role;
revoke execute on function public.mark_monday_duplicates_for_job(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Lead → profile trigger. Enrichment results and operator overrides land
--    on lead rows; this keeps the website's profile the latest word. Bulk
--    profile→lead writers set app.skip_lead_profile_sync to avoid echo.
-- ---------------------------------------------------------------------------

create or replace function public.sync_lead_to_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_update boolean := (tg_op = 'UPDATE');
begin
  if new.profile_id is null then
    return new;
  end if;
  if coalesce(current_setting('app.skip_lead_profile_sync', true), '') = '1' then
    return new;
  end if;

  update public.website_profiles p
  set
    -- affiliate ---------------------------------------------------------
    is_affiliate = case
      when new.is_affiliate_overridden_at is not null then new.is_affiliate
      when p.is_affiliate_overridden_at   is not null then p.is_affiliate
      when new.affiliate_checked_at is not null and (p.affiliate_checked_at is null or new.affiliate_checked_at >= p.affiliate_checked_at) then new.is_affiliate
      else p.is_affiliate end,
    affiliate_confidence = case when new.affiliate_checked_at is not null and (p.affiliate_checked_at is null or new.affiliate_checked_at >= p.affiliate_checked_at) then new.affiliate_confidence else p.affiliate_confidence end,
    affiliate_score      = case when new.affiliate_checked_at is not null and (p.affiliate_checked_at is null or new.affiliate_checked_at >= p.affiliate_checked_at) then new.affiliate_score      else p.affiliate_score      end,
    affiliate_source     = case when new.affiliate_checked_at is not null and (p.affiliate_checked_at is null or new.affiliate_checked_at >= p.affiliate_checked_at) then new.affiliate_source     else p.affiliate_source     end,
    affiliate_checked_at       = greatest(p.affiliate_checked_at, new.affiliate_checked_at),
    is_affiliate_overridden_at = greatest(p.is_affiliate_overridden_at, new.is_affiliate_overridden_at),
    -- rooster -----------------------------------------------------------
    is_rooster_partner = case
      when new.is_rooster_overridden_at is not null then new.is_rooster_partner
      when p.is_rooster_overridden_at   is not null then p.is_rooster_partner
      when new.rooster_checked_at is not null and (p.rooster_checked_at is null or new.rooster_checked_at >= p.rooster_checked_at) then new.is_rooster_partner
      else p.is_rooster_partner end,
    brand          = case when new.rooster_checked_at is not null and (p.rooster_checked_at is null or new.rooster_checked_at >= p.rooster_checked_at) then coalesce(new.brand, p.brand) else p.brand end,
    rooster_brands = case when new.rooster_checked_at is not null and (p.rooster_checked_at is null or new.rooster_checked_at >= p.rooster_checked_at) then coalesce(new.rooster_brands, p.rooster_brands) else p.rooster_brands end,
    rooster_source = case when new.rooster_checked_at is not null and (p.rooster_checked_at is null or new.rooster_checked_at >= p.rooster_checked_at) then new.rooster_source else p.rooster_source end,
    rooster_checked_at       = greatest(p.rooster_checked_at, new.rooster_checked_at),
    is_rooster_overridden_at = greatest(p.is_rooster_overridden_at, new.is_rooster_overridden_at),
    -- contact / s-tags --------------------------------------------------
    has_contact_details = case when new.contact_checked_at is not null and (p.contact_checked_at is null or new.contact_checked_at >= p.contact_checked_at) then new.has_contact_details else p.has_contact_details end,
    contact_checked_at  = greatest(p.contact_checked_at, new.contact_checked_at),
    has_s_tags          = case when new.s_tags_checked_at is not null and (p.s_tags_checked_at is null or new.s_tags_checked_at >= p.s_tags_checked_at) then new.has_s_tags else p.has_s_tags end,
    s_tags_checked_at   = greatest(p.s_tags_checked_at, new.s_tags_checked_at),
    -- monday ------------------------------------------------------------
    is_on_monday = case
      when new.monday_overridden_at is not null then coalesce(new.is_on_monday, false)
      when p.monday_overridden_at   is not null then p.is_on_monday
      when new.monday_checked_at is not null and (p.monday_matched_at is null or new.monday_checked_at >= p.monday_matched_at) then coalesce(new.is_on_monday, false)
      else p.is_on_monday end,
    monday_board = case
      when new.monday_overridden_at is not null then new.monday_board
      when p.monday_overridden_at   is not null then p.monday_board
      when new.monday_checked_at is not null and (p.monday_matched_at is null or new.monday_checked_at >= p.monday_matched_at) then new.monday_board
      else p.monday_board end,
    monday_item_id = case
      when new.monday_overridden_at is not null then new.monday_item_id
      when p.monday_overridden_at   is not null then p.monday_item_id
      when new.monday_checked_at is not null and (p.monday_matched_at is null or new.monday_checked_at >= p.monday_matched_at) then new.monday_item_id
      else p.monday_item_id end,
    monday_match_kind = case
      when new.monday_overridden_at is not null then coalesce(new.monday_match_kind, 'manual')
      when p.monday_overridden_at   is not null then p.monday_match_kind
      when new.monday_checked_at is not null and (p.monday_matched_at is null or new.monday_checked_at >= p.monday_matched_at) then new.monday_match_kind
      else p.monday_match_kind end,
    monday_matched_at    = greatest(p.monday_matched_at, new.monday_checked_at, new.monday_overridden_at),
    monday_overridden_at = greatest(p.monday_overridden_at, new.monday_overridden_at),
    -- not relevant: a change on the lead is a decision, copy it ------------
    is_not_relevant = case
      when v_is_update and new.is_not_relevant is distinct from old.is_not_relevant then coalesce(new.is_not_relevant, false)
      when coalesce(new.is_not_relevant, false) then true
      else p.is_not_relevant end,
    not_relevant_source = case
      when coalesce(new.is_not_relevant, false) and (not v_is_update or old.is_not_relevant is distinct from new.is_not_relevant) then coalesce(new.not_relevant_marked_by, 'operator')
      when v_is_update and coalesce(old.is_not_relevant, false) and not coalesce(new.is_not_relevant, false) then null
      else p.not_relevant_source end,
    not_relevant_at = case
      when coalesce(new.is_not_relevant, false) and (not v_is_update or old.is_not_relevant is distinct from new.is_not_relevant) then coalesce(new.not_relevant_marked_at, now())
      when v_is_update and coalesce(old.is_not_relevant, false) and not coalesce(new.is_not_relevant, false) then null
      else p.not_relevant_at end,
    -- system flag: clearing it on a lead clears the website and records an override
    system_flag = case when v_is_update and new.system_flag is distinct from old.system_flag then new.system_flag else p.system_flag end,
    system_flag_overridden_at = case when v_is_update and old.system_flag is not null and new.system_flag is null then now() else p.system_flag_overridden_at end,
    updated_at = now()
  where p.id = new.profile_id;

  return new;
end;
$$;

drop trigger if exists trg_sync_lead_to_profile on public.google_lead_gen_table;
create trigger trg_sync_lead_to_profile
after insert or update of
  is_affiliate, affiliate_confidence, affiliate_score, affiliate_checked_at, affiliate_source, is_affiliate_overridden_at,
  is_rooster_partner, brand, rooster_brands, rooster_checked_at, rooster_source, is_rooster_overridden_at,
  has_contact_details, contact_checked_at, has_s_tags, s_tags_checked_at,
  is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_checked_at, monday_overridden_at,
  is_not_relevant, not_relevant_marked_by, not_relevant_marked_at, system_flag
on public.google_lead_gen_table
for each row execute function public.sync_lead_to_profile();

-- ---------------------------------------------------------------------------
-- 9. complete_scrape_job v2.
--    known website  → appearance row only (when profile_dedupe_enabled)
--    new website    → profile + lead row + appearance
--    Verdicts are inherited from the profile while still inside their TTL;
--    an expired verdict on a re-seen website queues a re-check of its lead.
-- ---------------------------------------------------------------------------

create or replace function public.complete_scrape_job(
  p_job_id  uuid,
  p_results jsonb,
  p_summary jsonb default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_batch_id      bigint;
  v_job           public.scrape_queue;
  v_country_name  text;
  v_logged_in     boolean;
  v_logged_in_raw text;
  v_dedupe        boolean;
  v_ttl           jsonb;
  v_ttl_aff       integer;
  v_ttl_roo       integer;
  v_ttl_con       integer;
  v_ttl_stag      integer;
  v_new_profiles  bigint[] := '{}'::bigint[];
  v_n_new         integer := 0;
  v_n_known       integer := 0;
  v_n_leads       integer := 0;
  v_n_app         integer := 0;
  v_n_recheck     integer := 0;
  v_tmp           integer := 0;
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then
    raise exception 'scrape_queue row % not found', p_job_id;
  end if;

  select country_name into v_country_name
  from public.gologin_profiles
  where country_code = v_job.country_code;

  update public.batch_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1 into v_batch_id;

  v_dedupe   := coalesce(public.get_system_setting('profile_dedupe_enabled') = 'true'::jsonb, true);
  v_ttl      := coalesce(public.get_system_setting('verdict_ttl_days'), '{}'::jsonb);
  v_ttl_aff  := coalesce(nullif(v_ttl->>'affiliate', '')::integer, 90);
  v_ttl_roo  := coalesce(nullif(v_ttl->>'rooster',   '')::integer, 60);
  v_ttl_con  := coalesce(nullif(v_ttl->>'contact',   '')::integer, 180);
  v_ttl_stag := coalesce(nullif(v_ttl->>'stags',     '')::integer, 90);

  -- Lead rows are written from profile state here; the lead→profile trigger
  -- would only echo it back.
  perform set_config('app.skip_lead_profile_sync', '1', true);

  if p_results is not null and jsonb_typeof(p_results) = 'array' then
    drop table if exists tmp_scrape_results;
    create temp table tmp_scrape_results on commit drop as
    select
      row_number() over (order by nullif(r->>'overall_position', '')::integer nulls last, ord) as rn,
      r,
      coalesce(public.normalize_domain(coalesce(nullif(r->>'full_url', ''), r->>'url')), '') as nd
    from jsonb_array_elements(p_results) with ordinality as t(r, ord)
    where coalesce(r->>'url', '') <> ''
      and (v_job.result_type_filter is null or r->>'resultType' = v_job.result_type_filter);

    -- (1) websites we have never seen become profiles
    with ins as (
      insert into public.website_profiles (normalized_domain, registered_domain, brand_stem, display_name, source, first_seen_at, last_seen_at)
      select distinct on (nd) nd, coalesce(public.registered_domain(nd), nd), public.brand_stem(nd), nd, 'scrape', now(), now()
      from tmp_scrape_results
      where nd <> ''
      order by nd, rn
      on conflict (normalized_domain) do nothing
      returning id
    )
    select coalesce(array_agg(id), '{}'::bigint[]) into v_new_profiles from ins;
    v_n_new := coalesce(array_length(v_new_profiles, 1), 0);

    perform public.link_profile_relations(v_new_profiles);
    perform public.apply_db_system_flags(v_new_profiles);

    -- (2) which sightings become lead rows: the first sighting of a website
    --     that has no lead row yet — or every sighting when dedupe is off.
    drop table if exists tmp_lead_rows;
    create temp table tmp_lead_rows on commit drop as
    select t.rn, t.r, t.nd, p.id as profile_id
    from tmp_scrape_results t
    left join public.website_profiles p on p.normalized_domain = t.nd
    where (not v_dedupe)
       or t.nd = ''
       or (p.first_lead_id is null
           and t.rn = (select min(t2.rn) from tmp_scrape_results t2 where t2.nd = t.nd));

    -- (3) lead rows, inheriting the profile's still-valid verdicts
    with ins as (
      insert into public.google_lead_gen_table (
        keyword, country, country_code,
        url, domain,
        page_number, position_on_page, overall_position,
        result_type,
        batch_id, scrape_job_id,
        serp_screenshot_path, screenshot_content_link, seen_on,
        created_by_is_shadow, created_by_email,
        profile_id, system_flag,
        is_not_relevant, not_relevant_marked_at, not_relevant_marked_by,
        is_affiliate, affiliate_confidence, affiliate_score, affiliate_checked_at, affiliate_source, is_affiliate_overridden_at,
        is_rooster_partner, brand, rooster_brands, rooster_checked_at, rooster_source, is_rooster_overridden_at,
        has_contact_details, contact_checked_at,
        has_s_tags, s_tags_checked_at,
        inherited_from_lead_id, inherited_at
      )
      select
        coalesce(l.r->>'keyword', v_job.keyword),
        coalesce(l.r->>'country', v_country_name),
        v_job.country_code,
        l.r->>'url',
        l.r->>'full_url',
        nullif(l.r->>'page', '')::integer,
        nullif(l.r->>'position', '')::integer,
        nullif(l.r->>'overall_position', '')::integer,
        l.r->>'resultType',
        v_batch_id,
        v_job.id,
        nullif(l.r->>'serp_screenshot_path', ''),
        nullif(l.r->>'screenshot_content_link', ''),
        case lower(coalesce(l.r->>'seen_on', ''))
          when 'desktop' then 'desktop'
          when 'mobile'  then 'mobile'
          when 'both'    then 'both'
          else null
        end,
        coalesce(v_job.created_by_is_shadow, false),
        v_job.created_by_email,
        l.profile_id,
        p.system_flag,
        coalesce(p.is_not_relevant, false),
        case when p.is_not_relevant then coalesce(p.not_relevant_at, now()) end,
        case when p.is_not_relevant then coalesce(p.not_relevant_source, 'profile') end,
        -- affiliate: an override always carries; otherwise only inside the TTL
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.is_affiliate end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_confidence end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_score end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_checked_at end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_source end,
        p.is_affiliate_overridden_at,
        -- rooster
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.is_rooster_partner end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.brand end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.rooster_brands end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.rooster_checked_at end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.rooster_source end,
        p.is_rooster_overridden_at,
        -- contact / s-tags
        case when p.contact_checked_at > now() - make_interval(days => v_ttl_con) then p.has_contact_details end,
        case when p.contact_checked_at > now() - make_interval(days => v_ttl_con) then p.contact_checked_at end,
        case when p.s_tags_checked_at > now() - make_interval(days => v_ttl_stag) then p.has_s_tags end,
        case when p.s_tags_checked_at > now() - make_interval(days => v_ttl_stag) then p.s_tags_checked_at end,
        p.first_lead_id,
        case when p.affiliate_checked_at is not null or p.rooster_checked_at is not null or p.contact_checked_at is not null or p.s_tags_checked_at is not null then now() end
      from tmp_lead_rows l
      left join public.website_profiles p on p.id = l.profile_id
      returning id, profile_id
    ),
    firsts as (
      select distinct on (profile_id) profile_id, id
      from ins
      where profile_id is not null
      order by profile_id, id
    )
    update public.website_profiles p
    set first_lead_id = f.id, updated_at = now()
    from firsts f
    where p.id = f.profile_id
      and p.first_lead_id is null;

    select count(*) into v_n_leads from tmp_lead_rows;

    -- (4) appearance log: every sighting, lead row or not
    insert into public.website_appearances (
      profile_id, lead_id, scrape_job_id, batch_id,
      keyword, country_code, search_engine, result_type,
      url, page_number, position_on_page, overall_position, seen_on, serp_screenshot_path,
      created_lead, seen_at
    )
    select
      p.id,
      g.id,
      v_job.id,
      v_batch_id,
      coalesce(t.r->>'keyword', v_job.keyword),
      v_job.country_code,
      v_job.search_engine,
      t.r->>'resultType',
      t.r->>'url',
      nullif(t.r->>'page', '')::integer,
      nullif(t.r->>'position', '')::integer,
      nullif(t.r->>'overall_position', '')::integer,
      nullif(lower(t.r->>'seen_on'), ''),
      nullif(t.r->>'serp_screenshot_path', ''),
      (g.id is not null),
      now()
    from tmp_scrape_results t
    join public.website_profiles p on p.normalized_domain = t.nd
    left join tmp_lead_rows l on l.rn = t.rn
    left join lateral (
      select g0.id
      from public.google_lead_gen_table g0
      where l.rn is not null
        and g0.scrape_job_id = v_job.id
        and g0.profile_id = p.id
        and g0.url = t.r->>'url'
      order by g0.id
      limit 1
    ) g on true;
    get diagnostics v_n_app = row_count;

    -- (5) sighting stats on the profile
    update public.website_profiles p
    set last_seen_at     = now(),
        first_seen_at    = coalesce(p.first_seen_at, now()),
        appearance_count = p.appearance_count + s.n,
        updated_at       = now()
    from (select nd, count(*) as n from tmp_scrape_results where nd <> '' group by nd) s
    where p.normalized_domain = s.nd;

    select count(distinct nd) - v_n_new into v_n_known from tmp_scrape_results where nd <> '';

    -- (6) a website we already know, seen again, whose verdict has expired:
    --     re-check its lead row instead of trusting the old answer.
    if coalesce(v_job.with_enrichment, false) then
      insert into public.enrichment_fetch_queue (lead_id, country_code, url, want_html, want_screenshot, process_stages, created_by_email, created_by_is_shadow)
      select g.id, g.country_code, g.url, true, false, '["affiliate"]'::jsonb, v_job.created_by_email, coalesce(v_job.created_by_is_shadow, false)
      from public.website_profiles p
      join public.google_lead_gen_table g on g.id = p.first_lead_id
      where p.normalized_domain in (select nd from tmp_scrape_results where nd <> '')
        and not (p.id = any(v_new_profiles))
        and p.is_not_relevant = false
        and p.system_flag is null
        and p.is_on_monday is not true
        and p.is_affiliate_overridden_at is null
        and p.affiliate_checked_at is not null
        and p.affiliate_checked_at < now() - make_interval(days => v_ttl_aff)
        and g.url like 'http%'
        and g.country_code is not null
        and not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.status in ('pending', 'running', 'paused')
        );
      get diagnostics v_tmp = row_count;
      v_n_recheck := v_n_recheck + v_tmp;

      insert into public.enrichment_fetch_queue (lead_id, country_code, url, want_html, want_screenshot, process_stages, created_by_email, created_by_is_shadow)
      select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb, v_job.created_by_email, coalesce(v_job.created_by_is_shadow, false)
      from public.website_profiles p
      join public.google_lead_gen_table g on g.id = p.first_lead_id
      where p.normalized_domain in (select nd from tmp_scrape_results where nd <> '')
        and not (p.id = any(v_new_profiles))
        and p.is_not_relevant = false
        and p.system_flag is null
        and p.is_on_monday is not true
        and p.is_rooster_overridden_at is null
        and p.rooster_checked_at is not null
        and p.rooster_checked_at < now() - make_interval(days => v_ttl_roo)
        and g.url like 'http%'
        and g.country_code is not null
        and not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.status in ('pending', 'running', 'paused')
        );
      get diagnostics v_tmp = row_count;
      v_n_recheck := v_n_recheck + v_tmp;
    end if;

    drop table if exists tmp_lead_rows;
    drop table if exists tmp_scrape_results;
  end if;

  update public.scrape_queue
  set status         = 'completed',
      completed_at   = now(),
      batch_id       = v_batch_id,
      result_summary = coalesce(p_summary, '{}'::jsonb) || jsonb_build_object(
                         'websites_new',    v_n_new,
                         'websites_known',  v_n_known,
                         'lead_rows',       v_n_leads,
                         'appearances',     v_n_app,
                         'rechecks_queued', v_n_recheck
                       ),
      raw_results    = p_results,
      error_message  = null,
      updated_at     = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;

  if p_summary is not null then
    v_logged_in_raw := p_summary->>'is_logged_in';
    if v_logged_in_raw is not null and v_logged_in_raw <> 'null' then
      v_logged_in := (v_logged_in_raw = 'true');
      update public.gologin_profiles
      set is_google_logged_in      = v_logged_in,
          google_login_verified_at = now(),
          login_check_source       = 'auto',
          updated_at               = now()
      where country_code = v_job.country_code
        and not (
          v_logged_in = false
          and login_check_source = 'manual'
          and is_google_logged_in = true
        );
    end if;
  end if;

  -- Monday: answered from the profile (mirror only for never-checked websites).
  perform public.mark_monday_duplicates_for_job(p_job_id);

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. advance_enrichment_chain: system-flagged leads are not enrichable.
--     Body identical to 20260901120000 plus `system_flag is null`.
-- ---------------------------------------------------------------------------

create or replace function public.advance_enrichment_chain(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job         public.scrape_queue;
  v_total       integer;
  v_aff_done    integer;
  v_other_done  integer;
  v_now         timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  perform public.inherit_monday_data_for_lead(g.id)
  from public.google_lead_gen_table g
  where g.scrape_job_id = p_job_id
    and g.is_on_monday = true
    and g.monday_inherited_at is null;

  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id
    and is_not_relevant = false
    and system_flag is null
    and url is not null and url like 'http%'
    and country_code is not null
    and (force_enrich = true or is_on_monday is not true or monday_inherited_at is not null);

  if v_total = 0 then
    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  -- Stage 1: affiliate
  if v_job.enrichment_status is null or v_job.enrichment_status = 'pending' then
    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, (g.result_type = 'PPC'), '["affiliate"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and g.system_flag is null
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_affiliate_overridden_at is null
      and g.affiliate_checked_at is null;

    update public.scrape_queue
    set enrichment_status = 'affiliate_running',
        enrichment_started_at = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  -- Stage 2: rooster once affiliate resolved.
  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.system_flag is null
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and (
        g.is_affiliate_overridden_at is not null
        or g.affiliate_checked_at is not null
        or not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.process_stages @> '["affiliate"]'::jsonb
            and q.status in ('pending', 'running', 'paused')
        )
      );

    if v_aff_done < v_total then
      return 'affiliate_running';
    end if;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and g.system_flag is null
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_rooster_overridden_at is null
      and g.rooster_checked_at is null;

    update public.scrape_queue set enrichment_status = 'all_running' where id = p_job_id;
    return 'all_running';
  end if;

  -- Stage 3: wait for rooster, then complete.
  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.system_flag is null
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and (
        g.is_rooster_overridden_at is not null
        or g.rooster_checked_at is not null
        or not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.process_stages @> '["rooster"]'::jsonb
            and q.status in ('pending', 'running', 'paused')
        )
      );

    if v_other_done < v_total then
      return 'all_running';
    end if;

    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  return v_job.enrichment_status;
end;
$$;

grant execute on function public.advance_enrichment_chain(uuid) to service_role;
revoke execute on function public.advance_enrichment_chain(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. Search page helpers: every mirror match for a domain (not just the
--     first), and how fresh each board's mirror is.
-- ---------------------------------------------------------------------------

create or replace function public.search_website_on_monday_all(p_domain text)
returns table(
  board             text,
  item_id           text,
  item_name         text,
  match_kind        text,
  tier              integer,
  website           text,
  monday_updated_at timestamptz,
  synced_at         timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with n as (
    select
      coalesce(normalize_domain(p_domain), '')                                  as d,
      coalesce(registered_domain(normalize_domain(p_domain)), '')               as r,
      coalesce(brand_stem(normalize_domain(p_domain)), '')                      as s
  ),
  items as (
    select 'affiliates'::text as board, monday_item_id, name, website_normalized as w, website, monday_updated_at, synced_at from affiliates_table
    union all select 'leads', monday_item_id, name, website_normalized, website, monday_updated_at, synced_at from leads_table
    union all select 'not_relevant_leads', monday_item_id, name, website_normalized, website, monday_updated_at, synced_at from not_relevant_leads_table
    union all select 'email_undelivered_leads', monday_item_id, name, website_normalized, website, monday_updated_at, synced_at from email_undelivered_leads_table
  ),
  upd as (
    select 'affiliates'::text as board, monday_item_id, body_domains, body_stems from affiliates_updates_table
    union all select 'leads', monday_item_id, body_domains, body_stems from leads_updates_table
    union all select 'not_relevant_leads', monday_item_id, body_domains, body_stems from not_relevant_leads_updates_table
    union all select 'email_undelivered_leads', monday_item_id, body_domains, body_stems from email_undelivered_leads_updates_table
  ),
  hits as (
    select i.board, i.monday_item_id, i.name, i.website, i.monday_updated_at, i.synced_at, 'exact'::text as kind, 1 as tier
      from items i, n where n.d <> '' and i.w = n.d
    union all
    select i.board, i.monday_item_id, i.name, i.website, i.monday_updated_at, i.synced_at, 'exact_name', 2
      from items i, n where n.d <> '' and coalesce(i.w, '') = '' and i.name is not null and position('/' in i.name) = 0 and normalize_domain(i.name) = n.d
    union all
    select i.board, i.monday_item_id, i.name, i.website, i.monday_updated_at, i.synced_at, 'registered', 3
      from items i, n where n.r <> '' and coalesce(i.w, '') <> '' and i.w <> n.d and registered_domain(i.w) = n.r
    union all
    select i.board, i.monday_item_id, i.name, i.website, i.monday_updated_at, i.synced_at, 'registered_name', 4
      from items i, n where n.r <> '' and coalesce(i.w, '') = '' and i.name is not null and position('/' in i.name) = 0
                       and normalize_domain(i.name) <> n.d and registered_domain(normalize_domain(i.name)) = n.r
    union all
    select i.board, i.monday_item_id, i.name, i.website, i.monday_updated_at, i.synced_at, 'brand_stem', 5
      from items i, n where length(n.s) >= 12 and coalesce(i.w, '') <> '' and brand_stem(i.w) = n.s and registered_domain(i.w) <> n.r
    union all
    select i.board, i.monday_item_id, i.name, i.website, i.monday_updated_at, i.synced_at, 'mentioned_in_updates', 6
      from items i join upd u on u.board = i.board and u.monday_item_id = i.monday_item_id, n
      where n.r <> '' and u.body_domains @> array[n.r]
    union all
    select i.board, i.monday_item_id, i.name, i.website, i.monday_updated_at, i.synced_at, 'mentioned_in_updates_stem', 7
      from items i join upd u on u.board = i.board and u.monday_item_id = i.monday_item_id, n
      where length(n.s) >= 12 and u.body_stems @> array[n.s]
  ),
  best as (
    select distinct on (board, monday_item_id) *
    from hits
    order by board, monday_item_id, tier
  )
  select board, monday_item_id, name, kind, tier, website, monday_updated_at, synced_at
  from best
  order by tier, case board when 'affiliates' then 1 when 'leads' then 2 when 'not_relevant_leads' then 3 else 4 end, monday_updated_at desc nulls last
  limit 100;
$$;

grant execute on function public.search_website_on_monday_all(text) to service_role;
revoke execute on function public.search_website_on_monday_all(text) from anon, authenticated;

create or replace function public.get_monday_mirror_freshness()
returns table(
  board               text,
  items               bigint,
  updates             bigint,
  last_synced_at      timestamptz,
  last_monday_update  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select 'leads'::text,
         (select count(*) from leads_table), (select count(*) from leads_updates_table),
         (select max(synced_at) from leads_table), (select max(monday_updated_at) from leads_table)
  union all
  select 'affiliates',
         (select count(*) from affiliates_table), (select count(*) from affiliates_updates_table),
         (select max(synced_at) from affiliates_table), (select max(monday_updated_at) from affiliates_table)
  union all
  select 'not_relevant_leads',
         (select count(*) from not_relevant_leads_table), (select count(*) from not_relevant_leads_updates_table),
         (select max(synced_at) from not_relevant_leads_table), (select max(monday_updated_at) from not_relevant_leads_table)
  union all
  select 'email_undelivered_leads',
         (select count(*) from email_undelivered_leads_table), (select count(*) from email_undelivered_leads_updates_table),
         (select max(synced_at) from email_undelivered_leads_table), (select max(monday_updated_at) from email_undelivered_leads_table);
$$;

grant execute on function public.get_monday_mirror_freshness() to service_role;
revoke execute on function public.get_monday_mirror_freshness() from anon, authenticated;
