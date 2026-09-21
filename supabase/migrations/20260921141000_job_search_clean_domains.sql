-- Migration: fuzzy-match websites on the clean domain, not the raw URL.
--
-- google_lead_gen_table.domain holds the full URL ("https://www.jadaliyya.com"),
-- and the scheme and www drag trigram similarity down: against "jadalliya"
-- the raw URL scores 0.26 (below threshold, no match) while the clean domain
-- scores 0.41 and the bare name 0.54. website_profiles.normalized_domain
-- already holds the clean value and every lead is linked to one, so match on
-- that and on the name without its TLD.

create index if not exists idx_website_profiles_domain_trgm
  on public.website_profiles using gin (normalized_domain gin_trgm_ops);

create or replace function public.search_scrape_jobs(
  p_query      text    default '',
  p_countries  text[]  default null,
  p_engines    text[]  default null,
  p_statuses   text[]  default null,
  p_sources    text[]  default null,
  p_owners     text[]  default null,
  p_from       date    default null,
  p_to         date    default null,
  p_enrichment text    default null,
  p_limit      int     default 50,
  p_offset     int     default 0
)
returns table(
  job_id      uuid,
  score       real,
  reasons     text[],
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with
  tokens as (
    select array_remove(
             regexp_split_to_array(lower(btrim(coalesce(p_query, ''))), '\s+'),
             ''
           ) as t
  ),
  base as (
    select q.*, g.country_name
    from public.scrape_queue q
    left join public.gologin_profiles g on g.country_code = q.country_code
    where q.parent_scrape_job_id is null
      and (p_countries is null or array_length(p_countries, 1) is null or q.country_code = any(p_countries))
      and (p_engines   is null or array_length(p_engines, 1)   is null or q.search_engine = any(p_engines))
      and (p_statuses  is null or array_length(p_statuses, 1)  is null or q.status = any(p_statuses))
      and (p_sources   is null or array_length(p_sources, 1)   is null or q.scrape_source = any(p_sources))
      and (p_owners    is null or array_length(p_owners, 1)    is null or lower(q.created_by_email) = any(p_owners))
      and (p_from is null or q.created_at >= p_from::timestamptz)
      and (p_to   is null or q.created_at <  (p_to + 1)::timestamptz)
      and (
        p_enrichment is null
        or (p_enrichment = 'yes' and q.with_enrichment is true)
        or (p_enrichment = 'no'  and coalesce(q.with_enrichment, false) is false)
      )
  ),
  scored as (
    select
      b.id as job_id,
      (select min(m.s) from unnest((select t from tokens)) tok
         cross join lateral (
           select greatest(
             case when lower(b.keyword) = tok then 1.00
                  when lower(b.keyword) like tok || '%' then 0.90
                  when lower(b.keyword) like '%' || tok || '%' then 0.80
                  else 0 end,
             case when b.keyword_en is not null and lower(b.keyword_en) like '%' || tok || '%' then 0.75 else 0 end,
             case when lower(b.country_code) = tok then 0.85
                  when lower(coalesce(b.country_name, '')) like tok || '%' then 0.85
                  when lower(coalesce(b.status, '')) = tok then 0.70
                  when lower(coalesce(b.search_engine, '')) = tok then 0.70
                  when lower(coalesce(b.scrape_source, '')) = tok then 0.65
                  when lower(coalesce(b.language, '')) = tok then 0.60
                  when lower(coalesce(b.view_mode, '')) = tok then 0.60
                  when lower(coalesce(b.enrichment_status, '')) = tok then 0.60
                  else 0 end,
             case when lower(coalesce(b.created_by_display, '')) like '%' || tok || '%'
                    or lower(coalesce(b.created_by_username, '')) like '%' || tok || '%' then 0.70
                  else 0 end,
             case when tok ~ '^\d+$' and b.batch_id = tok::bigint then 0.95 else 0 end,
             -- Websites this batch found. Matched on the CLEAN domain and on
             -- the name without its TLD, so a partial ("jadaliyya") and a
             -- typo ("jadalliya") both land.
             coalesce((
               select greatest(
                        max(case when p.normalized_domain like '%' || tok || '%' then 0.78 else 0 end),
                        max(similarity(p.normalized_domain, tok)) * 0.70,
                        max(similarity(split_part(p.normalized_domain, '.', 1), tok)) * 0.75
                      )
               from public.google_lead_gen_table l
               join public.website_profiles p on p.id = l.profile_id
               where l.scrape_job_id = b.id
                 and (p.normalized_domain like '%' || tok || '%'
                      or similarity(p.normalized_domain, tok) > public.job_search_threshold()
                      or similarity(split_part(p.normalized_domain, '.', 1), tok) > public.job_search_threshold())
             ), 0),
             case when similarity(lower(b.keyword), tok) > public.job_search_threshold()
                  then similarity(lower(b.keyword), tok) * 0.65 else 0 end,
             case when lower(coalesce(b.error_message, '')) like '%' || tok || '%' then 0.50 else 0 end
           ) as s
         ) m
      ) as score,
      b.created_at
    from base b
  ),
  kept as (
    select s.job_id, s.score, s.created_at
    from scored s
    where (select coalesce(array_length(t, 1), 0) from tokens) = 0
       or s.score > 0
  ),
  counted as (
    select k.*, count(*) over () as total_count from kept k
  )
  select
    c.job_id,
    coalesce(c.score, 0)::real,
    (
      select array_remove(array[
        case when btrim(coalesce(p_query, '')) <> ''
                  and lower(b2.keyword) like '%' || lower(btrim(p_query)) || '%' then 'keyword' end,
        case when b2.keyword_en is not null and btrim(coalesce(p_query, '')) <> ''
                  and lower(b2.keyword_en) like '%' || lower(btrim(p_query)) || '%' then 'english keyword' end,
        case when exists (
               select 1
               from public.google_lead_gen_table l
               join public.website_profiles p on p.id = l.profile_id
               where l.scrape_job_id = b2.id
                 and btrim(coalesce(p_query, '')) <> ''
                 and (p.normalized_domain like '%' || lower(btrim(p_query)) || '%'
                      or similarity(p.normalized_domain, lower(btrim(p_query))) > public.job_search_threshold()
                      or similarity(split_part(p.normalized_domain, '.', 1), lower(btrim(p_query))) > public.job_search_threshold())
             ) then 'a website it found' end,
        case when c.score > 0 and c.score < 0.80 then 'close match' end
      ], null)
      from public.scrape_queue b2 where b2.id = c.job_id
    ) as reasons,
    c.total_count
  from counted c
  order by c.score desc, c.created_at desc
  limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset);
$$;

grant execute on function public.search_scrape_jobs(text, text[], text[], text[], text[], text[], date, date, text, int, int) to service_role;
revoke execute on function public.search_scrape_jobs(text, text[], text[], text[], text[], text[], date, date, text, int, int) from anon, authenticated;
