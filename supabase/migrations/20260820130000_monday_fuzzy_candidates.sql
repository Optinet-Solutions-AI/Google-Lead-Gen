-- ============================================================
-- Fuzzy "possible Monday matches" for operator validation.
--
-- search_website_on_monday() is EXACT (+ a few deterministic tiers). When it
-- returns nothing we show a flat "Not on Monday" — but we mirror the ENTIRE
-- Monday board locally, so we can do what Monday's own advanced search does:
-- a partial (LIKE) search that surfaces MULTIPLE candidates the operator can
-- eyeball and confirm. Confirming one sets the manual override, which now
-- persists across future scrapes (20260820120000).
--
-- Matches the domain's brand-stem (SLD, e.g. "eucasinorank" from
-- eucasinorank.com) against item TITLES, WEBSITE columns, and the UPDATES feed
-- text, across all 4 boards. Deduped by item, best score first. On-demand only
-- (one call when a lead drawer opens), so the un-indexed ILIKE scans are fine.
-- Requires stem length >= 4 so we don't match on "com"/"casino"-style noise.
-- ============================================================
create or replace function public.search_monday_candidates(p_domain text, p_limit int default 8)
returns table(board text, item_id text, item_name text, website text, matched_on text, score int)
language sql
stable
security definer
set search_path = public
as $$
  with n as (
    select split_part(registered_domain(normalize_domain(p_domain)), '.', 1) as sld
  ),
  cand as (
    -- ITEM title / website contains the stem (all 4 boards)
    select 'affiliates'::text as b, a.monday_item_id as id, a.name as nm, coalesce(a.website_normalized,'') as w,
           case when a.website_normalized ilike '%'||n.sld||'%' then 'website' else 'title' end as mo,
           case when a.website_normalized ilike '%'||n.sld||'%' then 90 else 72 end as sc
      from public.affiliates_table a, n
     where length(n.sld) >= 4 and (a.website_normalized ilike '%'||n.sld||'%' or a.name ilike '%'||n.sld||'%')
    union all
    select 'leads', l.monday_item_id, l.name, coalesce(l.website_normalized,''),
           case when l.website_normalized ilike '%'||n.sld||'%' then 'website' else 'title' end,
           case when l.website_normalized ilike '%'||n.sld||'%' then 84 else 66 end
      from public.leads_table l, n
     where length(n.sld) >= 4 and (l.website_normalized ilike '%'||n.sld||'%' or l.name ilike '%'||n.sld||'%')
    union all
    select 'not_relevant_leads', x.monday_item_id, x.name, coalesce(x.website_normalized,''),
           case when x.website_normalized ilike '%'||n.sld||'%' then 'website' else 'title' end,
           case when x.website_normalized ilike '%'||n.sld||'%' then 80 else 62 end
      from public.not_relevant_leads_table x, n
     where length(n.sld) >= 4 and (x.website_normalized ilike '%'||n.sld||'%' or x.name ilike '%'||n.sld||'%')
    union all
    select 'email_undelivered_leads', e.monday_item_id, e.name, coalesce(e.website_normalized,''),
           case when e.website_normalized ilike '%'||n.sld||'%' then 'website' else 'title' end,
           case when e.website_normalized ilike '%'||n.sld||'%' then 78 else 60 end
      from public.email_undelivered_leads_table e, n
     where length(n.sld) >= 4 and (e.website_normalized ilike '%'||n.sld||'%' or e.name ilike '%'||n.sld||'%')
    union all
    -- UPDATES feed text mentions the stem (affiliates + leads carry the mentions)
    select 'affiliates', i.monday_item_id, i.name, coalesce(i.website_normalized,''), 'updates', 52
      from public.affiliates_updates_table u
      join public.affiliates_table i on i.monday_item_id = u.monday_item_id, n
     where length(n.sld) >= 4 and u.body_text ilike '%'||n.sld||'%'
    union all
    select 'leads', i.monday_item_id, i.name, coalesce(i.website_normalized,''), 'updates', 50
      from public.leads_updates_table u
      join public.leads_table i on i.monday_item_id = u.monday_item_id, n
     where length(n.sld) >= 4 and u.body_text ilike '%'||n.sld||'%'
  )
  select board, item_id, item_name, website, matched_on, score
  from (
    select distinct on (id) b as board, id as item_id, nm as item_name, w as website, mo as matched_on, sc as score
    from cand
    order by id, sc desc
  ) dedup
  order by score desc, item_name
  limit greatest(1, least(p_limit, 25));
$$;

grant execute on function public.search_monday_candidates(text, int) to service_role, authenticated;
revoke execute on function public.search_monday_candidates(text, int) from anon;
