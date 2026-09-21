-- The batch view had no answer to "so what came out of this scrape?" —
-- you had to read 100 rows and count in your head. This is that answer in
-- one round trip: how many results were on-keyword, how many are websites
-- we already hold (and where), and how far the affiliate work got.
--
-- Takes the job ids rather than one id because a split batch is two rows
-- (organic from Apify, PPC from the VM) and the operator thinks of it as
-- one batch.

create or replace function public.job_analysis_summary(p_job_ids uuid[])
returns table (
  total              bigint,
  -- Relevance to the keyword, screened off the SERP.
  relevant           bigint,
  off_keyword        bigint,
  relevance_unknown  bigint,
  -- Where the website already exists. Monday and our own database are one
  -- merged corpus, so these three are exhaustive and mutually exclusive.
  on_monday          bigint,
  in_system          bigint,
  brand_new          bigint,
  -- Affiliate work, which only runs on the on-keyword rows.
  affiliate_yes      bigint,
  affiliate_no       bigint,
  affiliate_unknown  bigint,
  rooster_partners   bigint,
  with_contacts      bigint,
  distinct_domains   bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select
      g.is_relevant,
      g.is_on_monday,
      g.is_affiliate,
      g.is_rooster_partner,
      g.has_contact_details,
      g.domain,
      g.created_at,
      p.first_seen_at
    from public.google_lead_gen_table g
    left join public.website_profiles p on p.id = g.profile_id
    where g.scrape_job_id = any(p_job_ids)
      and g.is_not_relevant = false
      and g.system_flag is null
  ),
  classified as (
    select
      *,
      case
        when is_on_monday is true then 'monday'
        -- A minute of slack so the rows of one batch do not mark each
        -- other as pre-existing. Mirrors existingState() in the app.
        when first_seen_at is not null and first_seen_at < created_at - interval '1 minute' then 'system'
        else 'new'
      end as existing_state
    from rows
  )
  select
    count(*)                                              as total,
    count(*) filter (where is_relevant is true)           as relevant,
    count(*) filter (where is_relevant is false)          as off_keyword,
    count(*) filter (where is_relevant is null)           as relevance_unknown,
    count(*) filter (where existing_state = 'monday')     as on_monday,
    count(*) filter (where existing_state = 'system')     as in_system,
    count(*) filter (where existing_state = 'new')        as brand_new,
    count(*) filter (where is_affiliate is true)          as affiliate_yes,
    count(*) filter (where is_affiliate is false)         as affiliate_no,
    count(*) filter (where is_affiliate is null)          as affiliate_unknown,
    count(*) filter (where is_rooster_partner is true)    as rooster_partners,
    count(*) filter (where has_contact_details is true)   as with_contacts,
    count(distinct domain)                                as distinct_domains
  from classified;
$$;

comment on function public.job_analysis_summary(uuid[]) is
  'Counts for the analysis strip on the batch view: relevance, where the website already exists, and how far enrichment got. Excludes rows already hidden as not-relevant or system-flagged.';

grant execute on function public.job_analysis_summary(uuid[]) to authenticated, service_role;
