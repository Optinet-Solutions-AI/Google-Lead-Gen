-- Backfill for 20260918120000_website_profiles.sql.
--
-- Builds one profile per website from the 85k existing lead rows, links every
-- lead to its profile, turns each lead into an appearance-log row, folds the
-- Monday mirror in, links related hosts and applies the own-DB system flags.
-- Idempotent: every statement is an upsert or guarded by "not exists".
-- No lead rows are deleted — the leads table keeps its history; from now on
-- repeats are logged as appearances instead of new rows.

set local statement_timeout = '600s';

select set_config('app.skip_lead_profile_sync', '1', true);

-- 1. One profile per normalised host seen in the leads table.
insert into public.website_profiles (
  normalized_domain, registered_domain, brand_stem, display_name, source,
  first_lead_id, first_seen_at, last_seen_at, appearance_count
)
select
  x.nd,
  coalesce(public.registered_domain(x.nd), x.nd),
  public.brand_stem(x.nd),
  x.nd,
  'scrape',
  x.first_id,
  x.first_seen,
  x.last_seen,
  x.n
from (
  select
    public.normalize_domain(coalesce(domain, url)) as nd,
    min(id)         as first_id,
    min(created_at) as first_seen,
    max(created_at) as last_seen,
    count(*)        as n
  from public.google_lead_gen_table
  group by 1
) x
where coalesce(x.nd, '') <> ''
on conflict (normalized_domain) do update
  set first_lead_id    = coalesce(website_profiles.first_lead_id, excluded.first_lead_id),
      first_seen_at    = least(website_profiles.first_seen_at, excluded.first_seen_at),
      last_seen_at     = greatest(website_profiles.last_seen_at, excluded.last_seen_at),
      appearance_count = greatest(website_profiles.appearance_count, excluded.appearance_count),
      updated_at       = now();

-- 2. Link every lead to its profile.
update public.google_lead_gen_table g
set profile_id = p.id
from public.website_profiles p
where g.profile_id is null
  and p.normalized_domain = public.normalize_domain(coalesce(g.domain, g.url));

-- 3. Verdicts: the most recently checked lead per website wins; a manual
--    override wins over everything.
with latest as (
  select distinct on (profile_id) profile_id, is_affiliate, affiliate_confidence, affiliate_score, affiliate_checked_at, affiliate_source
  from public.google_lead_gen_table
  where profile_id is not null and affiliate_checked_at is not null
  order by profile_id, affiliate_checked_at desc, id desc
)
update public.website_profiles p
set is_affiliate = l.is_affiliate, affiliate_confidence = l.affiliate_confidence, affiliate_score = l.affiliate_score,
    affiliate_checked_at = l.affiliate_checked_at, affiliate_source = l.affiliate_source
from latest l where p.id = l.profile_id and p.affiliate_checked_at is null;

with ov as (
  select distinct on (profile_id) profile_id, is_affiliate, is_affiliate_overridden_at
  from public.google_lead_gen_table
  where profile_id is not null and is_affiliate_overridden_at is not null
  order by profile_id, is_affiliate_overridden_at desc, id desc
)
update public.website_profiles p
set is_affiliate = o.is_affiliate, is_affiliate_overridden_at = o.is_affiliate_overridden_at
from ov o where p.id = o.profile_id and p.is_affiliate_overridden_at is null;

with latest as (
  select distinct on (profile_id) profile_id, is_rooster_partner, brand, rooster_brands, rooster_checked_at, rooster_source
  from public.google_lead_gen_table
  where profile_id is not null and rooster_checked_at is not null
  order by profile_id, rooster_checked_at desc, id desc
)
update public.website_profiles p
set is_rooster_partner = l.is_rooster_partner, brand = l.brand, rooster_brands = l.rooster_brands,
    rooster_checked_at = l.rooster_checked_at, rooster_source = l.rooster_source
from latest l where p.id = l.profile_id and p.rooster_checked_at is null;

with ov as (
  select distinct on (profile_id) profile_id, is_rooster_partner, is_rooster_overridden_at
  from public.google_lead_gen_table
  where profile_id is not null and is_rooster_overridden_at is not null
  order by profile_id, is_rooster_overridden_at desc, id desc
)
update public.website_profiles p
set is_rooster_partner = o.is_rooster_partner, is_rooster_overridden_at = o.is_rooster_overridden_at
from ov o where p.id = o.profile_id and p.is_rooster_overridden_at is null;

with latest as (
  select distinct on (profile_id) profile_id, has_contact_details, contact_checked_at
  from public.google_lead_gen_table
  where profile_id is not null and contact_checked_at is not null
  order by profile_id, contact_checked_at desc, id desc
)
update public.website_profiles p
set has_contact_details = l.has_contact_details, contact_checked_at = l.contact_checked_at
from latest l where p.id = l.profile_id and p.contact_checked_at is null;

with latest as (
  select distinct on (profile_id) profile_id, has_s_tags, s_tags_checked_at
  from public.google_lead_gen_table
  where profile_id is not null and s_tags_checked_at is not null
  order by profile_id, s_tags_checked_at desc, id desc
)
update public.website_profiles p
set has_s_tags = l.has_s_tags, s_tags_checked_at = l.s_tags_checked_at
from latest l where p.id = l.profile_id and p.s_tags_checked_at is null;

-- Monday state from leads: an override wins, else the latest check.
with ov as (
  select distinct on (profile_id) profile_id, is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_overridden_at
  from public.google_lead_gen_table
  where profile_id is not null and monday_overridden_at is not null
  order by profile_id, monday_overridden_at desc, id desc
)
update public.website_profiles p
set is_on_monday = coalesce(o.is_on_monday, false), monday_board = o.monday_board, monday_item_id = o.monday_item_id,
    monday_match_kind = coalesce(o.monday_match_kind, 'manual'), monday_matched_at = o.monday_overridden_at, monday_overridden_at = o.monday_overridden_at
from ov o where p.id = o.profile_id and p.monday_overridden_at is null;

with latest as (
  select distinct on (profile_id) profile_id, is_on_monday, monday_board, monday_item_id, monday_match_kind, monday_checked_at
  from public.google_lead_gen_table
  where profile_id is not null and monday_checked_at is not null
  order by profile_id, monday_checked_at desc, id desc
)
update public.website_profiles p
set is_on_monday = coalesce(l.is_on_monday, false), monday_board = l.monday_board, monday_item_id = l.monday_item_id,
    monday_match_kind = l.monday_match_kind, monday_matched_at = l.monday_checked_at
from latest l where p.id = l.profile_id and p.monday_overridden_at is null and p.monday_matched_at is null;

-- Not relevant: any human / Monday / denylist mark on any lead of the website.
with nr as (
  select distinct on (profile_id) profile_id, not_relevant_marked_by, not_relevant_marked_at
  from public.google_lead_gen_table
  where profile_id is not null and is_not_relevant = true
  order by profile_id, not_relevant_marked_at desc nulls last, id desc
)
update public.website_profiles p
set is_not_relevant = true,
    not_relevant_source = coalesce(p.not_relevant_source, case nr.not_relevant_marked_by when 'monday_sync' then 'monday' else coalesce(nr.not_relevant_marked_by, 'operator') end),
    not_relevant_at     = coalesce(p.not_relevant_at, nr.not_relevant_marked_at, now())
from nr where p.id = nr.profile_id and p.is_not_relevant = false;

-- 4. Appearance log: one row per existing lead.
insert into public.website_appearances (
  profile_id, lead_id, scrape_job_id, batch_id, keyword, country_code, search_engine, result_type,
  url, page_number, position_on_page, overall_position, seen_on, serp_screenshot_path, created_lead, seen_at
)
select
  g.profile_id, g.id, g.scrape_job_id, g.batch_id, g.keyword, g.country_code, q.search_engine, g.result_type,
  g.url, g.page_number, g.position_on_page, g.overall_position, g.seen_on, g.serp_screenshot_path,
  (g.id = p.first_lead_id), g.created_at
from public.google_lead_gen_table g
join public.website_profiles p on p.id = g.profile_id
left join public.scrape_queue q on q.id = g.scrape_job_id
where not exists (select 1 from public.website_appearances a where a.lead_id = g.id);

-- 5. Monday mirror → profiles (creates profiles for Monday-only websites,
--    refreshes match kinds for everything).
select public.refresh_profiles_from_monday();

-- 6. Relations between related hosts, for every profile.
select public.link_profile_relations(array(select id from public.website_profiles));

-- 7. Own-DB system flags for every profile (denylist, social hosts, known list).
select public.apply_db_system_flags(null);

-- 8. Push the refreshed Monday verdict down to lead rows that disagree.
select public.propagate_profile_monday_to_leads();
