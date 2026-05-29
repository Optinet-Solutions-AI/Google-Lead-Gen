-- ============================================================
-- Shadow user: bidirectional visibility isolation.
--
-- A shadow user is a fully-functional account (typically with
-- admin privileges) whose work is invisible to non-shadow users,
-- and which itself cannot see non-shadow users' work. Use case:
-- an executive who wants the team's full lead-gen stack to
-- experiment with their own keyword/country mix without anyone
-- on the team seeing it — and without seeing the team's pipeline
-- on their own dashboard either.
--
-- How the isolation works:
--   1. user_profiles.is_shadow flags the shadow accounts.
--   2. scrape_queue.created_by_is_shadow is denormalised at insert
--      time (cheap: enqueue action looks up the creator's flag and
--      writes both columns together). Set once, never updated.
--   3. google_lead_gen_table.created_by_is_shadow inherits from the
--      parent scrape job via complete_scrape_job (this migration
--      patches the RPC). Workers don't know about shadow status.
--   4. Application-layer query filters in the dashboard apply
--      visibility rules per-viewer:
--        - viewer is shadow → only rows where created_by_email = me
--        - viewer is not shadow → rows where created_by_is_shadow = false
--      The DB layer enforces nothing on its own — service-role
--      bypasses RLS — so the filter is application-layer only.
--      DB-layer defence-in-depth via RLS is a follow-up if needed.
--
-- This migration only adds the columns, the helper RPC, and patches
-- complete_scrape_job. The dashboard wiring lands in the same PR.
-- ============================================================

alter table public.user_profiles
  add column if not exists is_shadow boolean not null default false;

alter table public.scrape_queue
  add column if not exists created_by_is_shadow boolean not null default false;

alter table public.google_lead_gen_table
  add column if not exists created_by_is_shadow boolean not null default false,
  add column if not exists created_by_email text;

create index if not exists idx_scrape_queue_created_by_is_shadow
  on public.scrape_queue (created_by_is_shadow)
  where created_by_is_shadow = true;

create index if not exists idx_google_lead_gen_created_by_is_shadow
  on public.google_lead_gen_table (created_by_is_shadow)
  where created_by_is_shadow = true;

create index if not exists idx_google_lead_gen_created_by_email
  on public.google_lead_gen_table (created_by_email)
  where created_by_email is not null;

-- Backfill created_by_email + created_by_is_shadow on existing leads
-- from their parent scrape_queue rows so the filter works for legacy
-- data too.
update public.google_lead_gen_table l
set created_by_email     = q.created_by_email,
    created_by_is_shadow = coalesce(q.created_by_is_shadow, false)
from public.scrape_queue q
where l.scrape_job_id = q.id
  and l.created_by_email is null;

-- ------------------------------------------------------------
-- Helper RPC: is the given user a shadow account?
-- Mirrors is_admin(); used by the dashboard's getShadowContext().
-- ------------------------------------------------------------
create or replace function public.is_shadow_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(is_shadow, false)
  from public.user_profiles
  where id = p_user_id;
$$;

grant execute on function public.is_shadow_user(uuid) to service_role, authenticated;

-- ------------------------------------------------------------
-- Patch complete_scrape_job: cascade created_by_is_shadow from
-- the scrape_queue row down onto the freshly-inserted
-- google_lead_gen_table rows. Body is the v3 from
-- 20260526040000_ppc_landing_screenshot with one new column in
-- the INSERT (.created_by_is_shadow) — everything else unchanged.
-- ------------------------------------------------------------
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

  if p_results is not null and jsonb_typeof(p_results) = 'array' then
    insert into public.google_lead_gen_table (
      keyword, country, country_code,
      url, domain,
      page_number, position_on_page, overall_position,
      result_type,
      batch_id, scrape_job_id,
      serp_screenshot_path,
      screenshot_content_link,
      seen_on,
      created_by_is_shadow,
      created_by_email
    )
    select
      coalesce(r->>'keyword', v_job.keyword),
      coalesce(r->>'country', v_country_name),
      v_job.country_code,
      r->>'url',
      r->>'full_url',
      nullif(r->>'page', '')::integer,
      nullif(r->>'position', '')::integer,
      nullif(r->>'overall_position', '')::integer,
      r->>'resultType',
      v_batch_id,
      v_job.id,
      nullif(r->>'serp_screenshot_path', ''),
      nullif(r->>'screenshot_content_link', ''),
      case lower(coalesce(r->>'seen_on', ''))
        when 'desktop' then 'desktop'
        when 'mobile'  then 'mobile'
        when 'both'    then 'both'
        else null
      end,
      coalesce(v_job.created_by_is_shadow, false),
      v_job.created_by_email
    from jsonb_array_elements(p_results) r
    where coalesce(r->>'url', '') <> ''
      and (v_job.result_type_filter is null or r->>'resultType' = v_job.result_type_filter);
  end if;

  update public.scrape_queue
  set status         = 'completed',
      completed_at   = now(),
      batch_id       = v_batch_id,
      result_summary = p_summary,
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

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;

-- ------------------------------------------------------------
-- Patch find_lead_cohort (from 20260526030000_lead_owner_cohort)
-- so the owner-network section in the lead drawer respects shadow
-- isolation. New params let the caller pass the viewer context;
-- siblings outside that context are filtered out.
-- ------------------------------------------------------------
drop function if exists public.find_lead_cohort(bigint);

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
  where
    case
      when p_viewer_shadow then lower(l.created_by_email) = lower(coalesce(p_viewer_email, '__none__'))
      else coalesce(l.created_by_is_shadow, false) = false
    end
  group by m.lead_id, l.domain, l.url, l.country_code, l.is_rooster_partner
  order by count(*) desc, l.domain asc
  limit 20;
$$;

grant execute on function public.find_lead_cohort(bigint, text, boolean) to service_role, authenticated;
revoke execute on function public.find_lead_cohort(bigint, text, boolean) from anon;
