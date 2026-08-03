-- ============================================================
-- Contact-extraction v3 — Monday source labeling (LGP-211..214)
--
-- Foundation for inheriting a matched Monday item's data (contacts,
-- s-tags, affiliate/rooster classification) INTO our tables, labeled as
-- coming from Monday.com rather than our own extraction. This lets the
-- enrichment chain skip paid work for the ~30k leads that are already on
-- Monday but currently sit blank in our system (LGP-210 audit).
--
--   211  contact_table.source enum gains 'monday'
--   212  s_tags_table.origin column ('system' | 'monday')
--   213  google_lead_gen_table classification provenance columns
--   214  get_monday_item_for_lead(lead_id) — read the matched replica row
-- ============================================================

-- ------------------------------------------------------------
-- 211. Contact provenance — allow a 'monday' table-level source.
--      (Per-item provenance rides ContactItem.method = 'monday'.)
-- ------------------------------------------------------------
alter table public.contact_table
  drop constraint if exists contact_table_source_check;
alter table public.contact_table
  add constraint contact_table_source_check
  check (source in ('regex', 'multi_page', 'openai', 'claude', 'hunter', 'manual', 'json_ld', 'mixed', 'monday'));

-- ------------------------------------------------------------
-- 212. s_tags origin — did this tag come from our extraction or Monday?
--      Defaults 'system' so every existing row keeps its current meaning.
-- ------------------------------------------------------------
alter table public.s_tags_table
  add column if not exists origin text not null default 'system'
    check (origin in ('system', 'monday'));

comment on column public.s_tags_table.origin is
  'Provenance of this s-tag: ''system'' (our extraction) or ''monday'' (inherited from a matched Monday item). Distinct from is_existing_on_monday, which only records that a system-extracted tag was ALSO found on Monday.';

-- ------------------------------------------------------------
-- 213. Classification provenance on the lead — was is_affiliate /
--      is_rooster_partner decided by our enrichment or inherited from
--      Monday? Null = not set by either yet. monday_inherited_at stamps
--      when we last pulled Monday data into this lead.
-- ------------------------------------------------------------
alter table public.google_lead_gen_table
  add column if not exists affiliate_source text
    check (affiliate_source in ('system', 'monday')),
  add column if not exists rooster_source text
    check (rooster_source in ('system', 'monday')),
  add column if not exists monday_inherited_at timestamptz;

comment on column public.google_lead_gen_table.affiliate_source is
  'Who set is_affiliate: ''system'' (enrichment scored it) or ''monday'' (inherited from the matched Monday item / affiliates board). Null when unset.';
comment on column public.google_lead_gen_table.rooster_source is
  'Who set is_rooster_partner/brand: ''system'' or ''monday''. Null when unset.';
comment on column public.google_lead_gen_table.monday_inherited_at is
  'When we last inherited data (contacts/s-tags/classification) from this lead''s matched Monday item.';

-- ------------------------------------------------------------
-- 214. Read a lead's matched Monday replica row as jsonb, from whichever
--      board it matched. Returns null when the lead isn't matched or the
--      replica row is missing. security definer so the service role +
--      enrichment path can call it uniformly.
-- ------------------------------------------------------------
create or replace function public.get_monday_item_for_lead(p_lead_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_item_id text;
  v_board   text;
  v_row     jsonb;
begin
  select monday_item_id, monday_board
    into v_item_id, v_board
  from public.google_lead_gen_table
  where id = p_lead_id;

  if v_item_id is null or v_board is null then
    return null;
  end if;

  if v_board = 'affiliates' then
    select to_jsonb(a.*) into v_row from public.affiliates_table a where a.monday_item_id = v_item_id;
  elsif v_board = 'leads' then
    select to_jsonb(a.*) into v_row from public.leads_table a where a.monday_item_id = v_item_id;
  elsif v_board = 'not_relevant_leads' then
    select to_jsonb(a.*) into v_row from public.not_relevant_leads_table a where a.monday_item_id = v_item_id;
  elsif v_board = 'email_undelivered_leads' then
    select to_jsonb(a.*) into v_row from public.email_undelivered_leads_table a where a.monday_item_id = v_item_id;
  else
    return null;
  end if;

  if v_row is not null then
    v_row := v_row || jsonb_build_object('_board', v_board);
  end if;
  return v_row;
end;
$$;

grant execute on function public.get_monday_item_for_lead(bigint) to service_role, authenticated;
