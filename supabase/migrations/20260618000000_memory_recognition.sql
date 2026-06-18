-- ============================================================
-- Memory / recognition feature — what an experienced human
-- affiliate checker does mentally, in DB.
--
-- Today every scrape inserts fresh rows that get enriched from
-- scratch — even when the domain has been scraped 12 times before
-- and is already a confirmed Rooster partner on Monday. That
-- burns proxy bandwidth re-fetching pages we've already seen.
--
-- This migration adds three things:
--   1. Inheritance: each new lead inherits the known enrichment
--      booleans (is_affiliate, is_rooster_partner, brand,
--      has_contact_details, has_s_tags) from the most recent prior
--      lead with the same normalized domain. The new row already
--      "knows" what we know without re-running enrichment.
--   2. Monday check + inheritance happen INSIDE complete_scrape_job
--      (immediately at scrape complete), not as the first
--      enrichment stage. The /scrape detail page then reports an
--      accurate "X auto-skipped (already known)" breakdown.
--   3. force_enrich flag: operators can override the auto-skip on
--      selected rows to re-run enrichment anyway (rebrand check,
--      fresh contact-info pull, etc.). advance_enrichment_chain
--      honours the flag so force_enrich=true rows always queue.
--
-- inherited_from_lead_id / inherited_at let the lead drawer show
-- "Last seen <date> in batch #N" as a Memory section.
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists inherited_from_lead_id bigint references public.google_lead_gen_table(id) on delete set null,
  add column if not exists inherited_at           timestamptz,
  -- Operators can force enrichment on a known/not-relevant lead by
  -- setting this to true via the UI's "Force enrich" action. The
  -- enrichment chain treats true as "always enqueue" — overrides
  -- the is_on_monday + is_not_relevant skips.
  add column if not exists force_enrich           boolean not null default false;

create index if not exists idx_lead_inherited_from
  on public.google_lead_gen_table (inherited_from_lead_id)
  where inherited_from_lead_id is not null;

create index if not exists idx_lead_force_enrich
  on public.google_lead_gen_table (force_enrich)
  where force_enrich = true;

-- ------------------------------------------------------------
-- Patch complete_scrape_job to:
--   a) keep doing what it already does (insert leads, mark
--      scrape_queue completed, cascade login-state, etc.)
--   b) run mark_monday_duplicates_for_job(p_job_id) inline so
--      is_on_monday / is_not_relevant flags are correct as soon as
--      the row is visible in /scrape and /leads
--   c) inherit prior-lead state for every domain we've seen before
--      (latest matching row by created_at, excluding rows from
--      this job)
--
-- Body otherwise identical to the v4 from
-- 20260528220000_shadow_user.sql.
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

  -- Mark scrape_queue completed BEFORE the Monday-check + inheritance
  -- so anyone polling status sees the job done even if those
  -- post-processing steps stall on a giant batch.
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

  -- (b) Monday match — sets is_on_monday, monday_board, monday_item_id,
  --     and is_not_relevant (when matched on not_relevant_leads).
  perform public.mark_monday_duplicates_for_job(p_job_id);

  -- (c) Inheritance — for each new lead in this job, find the latest
  --     prior lead with the same normalized domain (excluding this
  --     job) and copy forward the enrichment booleans we already
  --     know. We don't copy is_on_monday/is_not_relevant since the
  --     Monday check above already did that authoritatively against
  --     the live mirror.
  with new_leads as (
    select id, normalize_domain(coalesce(domain, url)) as nd
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
  ),
  -- For each new lead, pick the single most-recent prior lead with
  -- a matching domain. lateral join lets us limit to 1 per group.
  matches as (
    select n.id as new_id, prior.*
    from new_leads n
    cross join lateral (
      select id,
             is_affiliate,
             affiliate_confidence,
             affiliate_score,
             is_rooster_partner,
             brand,
             has_contact_details,
             has_s_tags,
             affiliate_checked_at,
             rooster_checked_at,
             contact_checked_at,
             s_tags_checked_at
      from public.google_lead_gen_table p
      where p.scrape_job_id <> p_job_id
        and normalize_domain(coalesce(p.domain, p.url)) = n.nd
        and n.nd is not null
        and n.nd <> ''
      order by p.created_at desc
      limit 1
    ) as prior
    where prior.id is not null
  )
  update public.google_lead_gen_table g
  set inherited_from_lead_id = m.id,
      inherited_at           = now(),
      -- Only fill where the new row hasn't already been classified
      -- by something more authoritative this run (Monday check ran
      -- above; we don't override its is_on_monday / is_not_relevant).
      is_affiliate           = coalesce(g.is_affiliate, m.is_affiliate),
      affiliate_confidence   = coalesce(g.affiliate_confidence, m.affiliate_confidence),
      affiliate_score        = coalesce(g.affiliate_score, m.affiliate_score),
      is_rooster_partner     = coalesce(g.is_rooster_partner, m.is_rooster_partner),
      brand                  = coalesce(g.brand, m.brand),
      has_contact_details    = coalesce(g.has_contact_details, m.has_contact_details),
      has_s_tags             = coalesce(g.has_s_tags, m.has_s_tags),
      -- Stamp the checked_at timestamps from the prior run so the
      -- enrichment chain treats the booleans as "already done" and
      -- doesn't re-enqueue.
      affiliate_checked_at   = coalesce(g.affiliate_checked_at, m.affiliate_checked_at),
      rooster_checked_at     = coalesce(g.rooster_checked_at, m.rooster_checked_at),
      contact_checked_at     = coalesce(g.contact_checked_at, m.contact_checked_at),
      s_tags_checked_at      = coalesce(g.s_tags_checked_at, m.s_tags_checked_at)
  from matches m
  where g.id = m.new_id;

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;

-- ------------------------------------------------------------
-- Patch advance_enrichment_chain — extend the skip predicate so
-- is_on_monday rows also skip enrichment by default, unless
-- force_enrich=true. Body otherwise identical to v3 from
-- 20260505040000_chain_stops_at_rooster.sql.
-- ------------------------------------------------------------
create or replace function public.advance_enrichment_chain(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job             public.scrape_queue;
  v_total           integer;
  v_aff_done        integer;
  v_other_done      integer;
  v_aff_count       integer;
  v_stag_done       integer;
  v_now             timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  -- Skip predicate: a lead is "enrichable" when it's NOT already
  -- known on Monday, NOT marked not-relevant, OR force_enrich=true
  -- (operator override). The `force_enrich OR (...)` form lets a
  -- single bulk-action update unstick an entire set of known leads.
  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id
    and is_not_relevant = false
    and (force_enrich = true or is_on_monday is not true);

  if v_total = 0 then
    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  if v_job.enrichment_status is null or v_job.enrichment_status = 'pending' then
    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true,
           (g.result_type = 'PPC'),
           '["affiliate"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_affiliate_overridden_at is null
      and g.affiliate_checked_at is null;

    update public.scrape_queue
    set enrichment_status      = 'affiliate_running',
        enrichment_started_at  = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_done
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and is_not_relevant = false
      and (force_enrich = true or is_on_monday is not true)
      and (is_affiliate_overridden_at is not null or affiliate_checked_at is not null);

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
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_rooster_overridden_at is null
      and g.rooster_checked_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["contact"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_contact_overridden_at is null
      and g.contact_checked_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["stag"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_affiliate = true
      and g.is_stag_overridden_at is null
      and g.s_tags_checked_at is null;

    update public.scrape_queue
    set enrichment_status = 'all_running'
    where id = p_job_id;
    return 'all_running';
  end if;

  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_done
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and is_not_relevant = false
      and (force_enrich = true or is_on_monday is not true)
      and (is_rooster_overridden_at is not null or rooster_checked_at is not null)
      and (is_contact_overridden_at is not null or contact_checked_at is not null);

    select count(*) into v_aff_count
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and is_not_relevant = false
      and (force_enrich = true or is_on_monday is not true)
      and is_affiliate = true;

    select count(*) into v_stag_done
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and is_not_relevant = false
      and (force_enrich = true or is_on_monday is not true)
      and is_affiliate = true
      and (is_stag_overridden_at is not null or s_tags_checked_at is not null);

    if v_other_done < v_total or v_stag_done < v_aff_count then
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

-- ------------------------------------------------------------
-- force_enrich_leads — bulk-set the override + clear the
-- enrichment-done timestamps for the affected stages so the chain
-- re-enqueues them on the next tick. Returns the number of rows
-- actually flipped (false → true) so the caller can show a "N
-- leads queued" toast.
-- ------------------------------------------------------------
create or replace function public.force_enrich_leads(p_lead_ids bigint[])
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with upd as (
    update public.google_lead_gen_table
    set force_enrich         = true,
        -- Clear timestamps so the chain treats them as un-enriched
        -- and queues fresh fetches. We don't clear the booleans
        -- themselves — they stay as the "last known" value until
        -- the new enrichment overwrites them. (No updated_at column
        -- on this table — only created_at; the parent job's
        -- updated_at is bumped in the job_reset CTE below.)
        affiliate_checked_at = null,
        rooster_checked_at   = null,
        contact_checked_at   = null,
        s_tags_checked_at    = null
    where id = any(p_lead_ids)
      and force_enrich = false
    returning id, scrape_job_id
  ),
  jobs as (
    select distinct scrape_job_id as id from upd where scrape_job_id is not null
  ),
  job_reset as (
    update public.scrape_queue
    set enrichment_status      = null,
        enrichment_completed_at = null,
        updated_at             = now()
    where id in (select id from jobs)
    returning id
  )
  select count(*) into v_count from upd;
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.force_enrich_leads(bigint[]) to service_role;
revoke execute on function public.force_enrich_leads(bigint[]) from anon, authenticated;
