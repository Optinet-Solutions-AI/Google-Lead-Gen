-- ============================================================
-- Social/shared-host leads must NOT match Monday on the bare domain.
--
-- QA (Supriya, 2026-08-05): Google/Bing SERP results that are social URLs
-- — youtube.com/watch?v=…, reddit.com/r/…/comments/…, facebook.com/<page>,
-- instagram.com/<handle>, x.com/<handle> — were being shown as Affiliates.
-- normalize_domain() strips the path, so every such URL collapses to the
-- bare platform host (youtube.com, reddit.com, …). search_website_on_monday
-- then matches ANY Monday row that shares that host, so a random YouTube
-- video or a Reddit thread (or facebook.com/spelinspektionen, the Swedish
-- gambling REGULATOR) inherits a real affiliate's classification.
--
-- On a shared host the identity is the HANDLE (the path), never the domain.
-- Since the matcher only ever sees the bare host (path already stripped by
-- normalize_domain), a bare social host carries no identity and must match
-- nothing. We blank d/r/s in the input CTE when the host is social, which
-- makes every tier's `n.d <> ''` / `n.r <> ''` / `n.s <> ''` guard fail — so
-- no tier fires. Non-social domains are completely unaffected: the entire
-- tier body below is byte-for-byte the shipped 20260713120000 version; only
-- the `n` CTE changed.
--
-- (Handle-level POSITIVE matching — correctly recognising a social profile
-- that genuinely is a Monday affiliate — would need handles preserved in
-- both the lead domain and Monday's website_normalized; that's a separate
-- enhancement. This migration only stops the false positives.)
-- ============================================================

create or replace function public.is_social_host(p_registered text)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(lower(p_registered), '') in (
    'instagram.com','youtube.com','youtu.be','twitter.com','x.com','tiktok.com',
    'facebook.com','fb.com','m.facebook.com','t.me','telegram.me','telegram.org',
    'twitch.tv','kick.com','snapchat.com','linkedin.com','reddit.com',
    'pinterest.com','threads.net','vk.com','linktr.ee','discord.gg','discord.com',
    'medium.com','tumblr.com','quora.com','wa.me','whatsapp.com','spotify.com',
    'soundcloud.com','vimeo.com','dailymotion.com','rumble.com','onlyfans.com',
    'patreon.com','telegra.ph'
  );
$$;

grant execute on function public.is_social_host(text) to service_role, anon, authenticated;

drop function if exists public.search_website_on_monday(text);

create or replace function public.search_website_on_monday(p_domain text)
returns table(board text, item_id text, item_name text, match_kind text)
language sql
stable
security definer
set search_path = public
as $$
  with raw as (
    select normalize_domain(p_domain) as d0
  ),
  flags as (
    select d0, is_social_host(registered_domain(d0)) as soc from raw
  ),
  n as (
    -- Blank the match keys for social/shared hosts so no tier can fire.
    select
      case when soc then '' else d0 end                       as d,
      case when soc then '' else registered_domain(d0) end    as r,
      case when soc then '' else brand_stem(d0) end            as s
    from flags
  )
  -- ----- Priority 1: exact normalized (website column) -----
  (select 'affiliates'::text, monday_item_id, name, 'exact'::text
     from affiliates_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'exact'::text
     from leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'exact'::text
     from not_relevant_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'exact'::text
     from email_undelivered_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  -- ----- Priority 2: exact name (domain lives in the item title) -----
  union all
  (select 'affiliates'::text, monday_item_id, name, 'exact_name'::text
     from affiliates_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'exact_name'::text
     from leads_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'exact_name'::text
     from not_relevant_leads_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'exact_name'::text
     from email_undelivered_leads_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  -- ----- Priority 3: registered-domain (eTLD+1, website column) -----
  union all
  (select 'affiliates'::text, monday_item_id, name, 'registered'::text
     from affiliates_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'registered'::text
     from leads_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'registered'::text
     from not_relevant_leads_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'registered'::text
     from email_undelivered_leads_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  -- ----- Priority 4: registered-domain from the item title -----
  union all
  (select 'affiliates'::text, monday_item_id, name, 'registered_name'::text
     from affiliates_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'registered_name'::text
     from leads_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'registered_name'::text
     from not_relevant_leads_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'registered_name'::text
     from email_undelivered_leads_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  -- ----- Priority 5: brand-stem (mirror domains across TLDs, stem >= 12) -----
  union all
  (select 'affiliates'::text, monday_item_id, name, 'brand_stem'::text
     from affiliates_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'brand_stem'::text
     from leads_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'brand_stem'::text
     from not_relevant_leads_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'brand_stem'::text
     from email_undelivered_leads_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  -- ----- Priority 6: mentioned in a board item's updates/comments feed -----
  union all
  (select 'affiliates'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from affiliates_updates_table u
     join affiliates_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  union all
  (select 'leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from leads_updates_table u
     join leads_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  union all
  (select 'not_relevant_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from not_relevant_leads_updates_table u
     join not_relevant_leads_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from email_undelivered_leads_updates_table u
     join email_undelivered_leads_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;
