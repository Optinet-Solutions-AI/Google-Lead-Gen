-- ============================================================
-- Owner-network cohort: one row per WEBSITE, not per lead.
--
-- QA (2026-08-05): the lead drawer's "Owner network" listed the same
-- website over and over — bookies.com ×20, 99bitcoins.com ×17 — because the
-- same site scraped in different countries is a separate google_lead_gen row,
-- and find_lead_cohort grouped per lead_id then LIMIT 20. Country doesn't
-- matter for this signal, so the duplicates were pure noise AND they crowded
-- genuinely distinct sibling sites out of the top 20.
--
-- Fix: dedup by host (normalize_domain of domain/url) BEFORE the limit, so the
-- section shows up to 20 DISTINCT websites. Per host we keep the strongest
-- match (max shared_count) as the representative lead_id for click-through,
-- OR the Rooster flag across its countries, and surface the max shared_count.
-- Return signature is unchanged (CohortSibling in detail-query.ts).
-- ============================================================

drop function if exists public.find_lead_cohort(bigint, text, boolean);

create or replace function public.find_lead_cohort(
  p_lead_id        bigint,
  p_viewer_email   text default null,
  p_viewer_shadow  boolean default false
)
returns table (
  lead_id        bigint,
  domain         text,
  url            text,
  country_code   text,
  is_rooster_partner boolean,
  shared_count   integer,
  shared_tags    jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with my_tags as (
    select distinct lower(s_tag) as s_tag_key
    from public.s_tags_table
    where lead_id = p_lead_id and s_tag is not null
  ),
  matching as (
    select t.lead_id, t.s_tag, t.source_param, t.brand
    from public.s_tags_table t
    join my_tags m on lower(t.s_tag) = m.s_tag_key
    where t.lead_id <> p_lead_id
  ),
  per_lead as (
    select
      m.lead_id,
      l.domain,
      l.url,
      l.country_code,
      l.is_rooster_partner,
      -- Website identity: normalized host (protocol/www/path stripped). Leads
      -- with no domain/url can't be merged, so key them by id.
      coalesce(nullif(public.normalize_domain(coalesce(l.domain, l.url)), ''),
               'lead:' || m.lead_id::text) as host_key,
      count(*)::integer as shared_count,
      jsonb_agg(distinct jsonb_build_object(
        's_tag', m.s_tag,
        'source_param', m.source_param,
        'brand', m.brand
      )) as shared_tags
    from matching m
    join public.google_lead_gen_table l on l.id = m.lead_id
    where
      case
        when p_viewer_shadow then lower(l.created_by_email) = lower(coalesce(p_viewer_email, '__none__'))
        else coalesce(l.created_by_is_shadow, false) = false
      end
    group by m.lead_id, l.domain, l.url, l.country_code, l.is_rooster_partner
  ),
  ranked as (
    select
      pl.*,
      row_number() over (partition by host_key order by shared_count desc, lead_id asc) as rn,
      max(shared_count) over (partition by host_key)                     as host_shared_count,
      bool_or(coalesce(is_rooster_partner, false)) over (partition by host_key) as host_rooster
    from per_lead pl
  )
  select
    lead_id,
    domain,
    url,
    country_code,
    host_rooster       as is_rooster_partner,
    host_shared_count  as shared_count,
    shared_tags
  from ranked
  where rn = 1
  order by host_shared_count desc, domain asc
  limit 20;
$$;

grant execute on function public.find_lead_cohort(bigint, text, boolean) to service_role, authenticated;
revoke execute on function public.find_lead_cohort(bigint, text, boolean) from anon;
