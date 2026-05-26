-- ============================================================
-- find_lead_cohort — discover affiliate sites that likely share
-- an operator by looking for overlapping s-tag values.
--
-- An s-tag is an affiliate-program slot ID. If two different
-- affiliate sites both carry "btag=xyz789" on their outbound links,
-- the same partner gets paid for traffic from either — which is
-- strong (not definitive) evidence the sites are run by the same
-- operator. This RPC returns every other lead in the database that
-- shares at least one s-tag value with the input lead, sorted by
-- how many tags they share.
--
-- Operator workflow: pull up a lead, see "shares 3 s-tags with
-- example-casino-2.com and example-casino-3.com" → likely same
-- owner running a stable of sites, can decide whether to push the
-- whole network to Monday at once.
--
-- Match key is `lower(s_tag)` only — not (source_param, s_tag) —
-- because the operator-identifying part is the unique value itself
-- (e.g. "casino-pro-42"); the param name is usually a quirk of the
-- destination program. Cap at top 20 siblings to keep the drawer
-- fast for popular tags that show up across hundreds of sites.
-- ============================================================

create or replace function public.find_lead_cohort(p_lead_id bigint)
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
    select t.lead_id,
           t.s_tag,
           t.source_param,
           t.brand
    from public.s_tags_table t
    join my_tags m on lower(t.s_tag) = m.s_tag_key
    where t.lead_id <> p_lead_id
  )
  select
    m.lead_id,
    l.domain,
    l.url,
    l.country_code,
    l.is_rooster_partner,
    count(*)::integer as shared_count,
    jsonb_agg(distinct jsonb_build_object(
      's_tag', m.s_tag,
      'source_param', m.source_param,
      'brand', m.brand
    )) as shared_tags
  from matching m
  join public.google_lead_gen_table l on l.id = m.lead_id
  group by m.lead_id, l.domain, l.url, l.country_code, l.is_rooster_partner
  order by count(*) desc, l.domain asc
  limit 20;
$$;

grant execute on function public.find_lead_cohort(bigint) to service_role, authenticated;
revoke execute on function public.find_lead_cohort(bigint) from anon;
