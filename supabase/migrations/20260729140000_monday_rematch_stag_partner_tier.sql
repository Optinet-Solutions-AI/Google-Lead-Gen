-- ============================================================
-- Add an S-tag / partner tier to the lead-level Monday rematch.
--
-- QA (Darren, batch 2266, 2026-07-29): leads that belong to a partner
-- we already have on Monday show "Is on Monday = NO" because the
-- partner is recorded under a DIFFERENT domain (affiliates run networks
-- of many domains) — the website match only knows the exact/registered
-- domain, name, brand-stem, or a domain literally mentioned in an
-- item's updates. A brand-new domain in a known partner's network has
-- no website signal.
--
-- But affiliate tracking S-tags DO identify the partner: e.g. the
-- seoteam item's updates contain "Wyns 329700 = Seoteam". If a lead's
-- extracted S-tag matches a tag already on Monday (via
-- search_s_tag_on_monday, which scans update bodies + item column
-- values), the partner is ours regardless of the domain.
--
-- Fix: rematch_monday_for_leads now falls back to an S-tag match when
-- the website match misses. Website match still wins when present
-- (more precise); the S-tag tier only fills the gap.
--
-- Scope/limits (be explicit): this only helps leads that HAVE an S-tag
-- in s_tags_table. Plain organic SERP leads with no S-tag extracted are
-- unaffected — those still need S-tag extraction run first, or a manual
-- override. Manual overrides (monday_overridden_at) are still respected.
-- ============================================================

create or replace function public.rematch_monday_for_leads(
  p_lead_ids bigint[]
)
returns table(checked integer, flipped integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_checked integer := 0;
  v_flipped integer := 0;
begin
  with leads as (
    select
      id,
      is_on_monday as prior_flag,
      monday_board as prior_board,
      normalize_domain(coalesce(domain, url)) as nd
    from public.google_lead_gen_table
    where id = any(p_lead_ids)
      and monday_overridden_at is null
  ),
  -- Tier A: website match (unchanged, most precise — wins when present).
  web as (
    select l.id as lead_id, l.prior_flag, l.prior_board, l.nd,
           m.board, m.item_id, m.match_kind
    from leads l
    left join lateral (
      select * from public.search_website_on_monday(l.nd) limit 1
    ) m on true
  ),
  -- Tier B: S-tag / partner match — ONLY for leads the website match
  -- missed. Walk each of the lead's extracted S-tags; first hit wins.
  stag as (
    select distinct on (w.lead_id)
      w.lead_id, st.item_id, st.kind
    from web w
    join public.s_tags_table s on s.lead_id = w.lead_id
    cross join lateral (
      select * from public.search_s_tag_on_monday(s.s_tag) limit 1
    ) st
    where w.item_id is null
      and coalesce(s.s_tag, '') <> ''
      and st.item_id is not null
    order by w.lead_id, s.id
  ),
  final as (
    select
      w.lead_id, w.prior_flag, w.prior_board,
      coalesce(w.board,     case when b.item_id is not null then 's_tag' end)          as board,
      coalesce(w.item_id,   b.item_id)                                                 as item_id,
      coalesce(w.match_kind, case when b.item_id is not null then 's_tag_partner' end) as match_kind
    from web w
    left join stag b on b.lead_id = w.lead_id
  ),
  upd as (
    update public.google_lead_gen_table g
    set is_on_monday      = (f.item_id is not null),
        monday_board      = f.board,
        monday_item_id    = f.item_id,
        monday_match_kind = f.match_kind
    from final f
    where g.id = f.lead_id
    returning
      f.prior_flag,
      g.is_on_monday,
      f.prior_board,
      g.monday_board
  )
  select
    count(*)::integer,
    count(*) filter (
      where prior_flag is distinct from is_on_monday
         or prior_board is distinct from monday_board
    )::integer
    into v_checked, v_flipped
  from upd;

  return query select v_checked, v_flipped;
end;
$$;

grant execute on function public.rematch_monday_for_leads(bigint[]) to service_role;
revoke execute on function public.rematch_monday_for_leads(bigint[]) from anon, authenticated;
