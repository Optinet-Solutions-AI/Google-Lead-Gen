-- Migration: advanced search for scrape batches.
--
-- The list search could only find a literal substring, and it was ANDed with
-- whatever day/owner scope the page happened to be on — so a search was
-- silently narrowed by filters the person was not thinking about.
--
-- This is a standalone search: it takes its OWN filters, ignores the page
-- scope entirely, ranks by how well each row matches, and says why it
-- matched. Fuzzy matching is real (pg_trgm), so "jadalliya" finds
-- jadaliyya.com and a mistyped keyword still lands.

create extension if not exists pg_trgm;

-- Trigram indexes for the fuzzy paths. Without these, similarity() over
-- 85k lead domains is a sequential scan on every keystroke.
create index if not exists idx_scrape_queue_keyword_trgm
  on public.scrape_queue using gin (keyword gin_trgm_ops);
create index if not exists idx_scrape_queue_keyword_en_trgm
  on public.scrape_queue using gin (keyword_en gin_trgm_ops)
  where keyword_en is not null;
create index if not exists idx_leads_domain_trgm
  on public.google_lead_gen_table using gin (domain gin_trgm_ops)
  where domain is not null;

-- How close a trigram match has to be before we call it "similar".
-- 0.3 is permissive enough for a typo, tight enough to avoid noise.
create or replace function public.job_search_threshold()
returns real language sql immutable as $$ select 0.30::real $$;

/**
 * Search scrape batches.
 *
 * Every word in p_query must match somewhere (AND across words, OR across
 * fields). Structured arguments are independent filters, each ignored when
 * null/empty. Rows come back ranked, with the reasons they matched.
 */
create or replace function public.search_scrape_jobs(
  p_query      text    default '',
  p_countries  text[]  default null,
  p_engines    text[]  default null,
  p_statuses   text[]  default null,
  p_sources    text[]  default null,
  p_owners     text[]  default null,
  p_from       date    default null,
  p_to         date    default null,
  p_enrichment text    default null,   -- 'yes' | 'no' | null
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
  -- Structured filters first: cheap, indexed, and they shrink what the
  -- fuzzy pass has to look at.
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
  -- Best score for each word against each row, plus why.
  scored as (
    select
      b.id as job_id,
      (select min(m.s) from unnest((select t from tokens)) tok
         cross join lateral (
           select greatest(
             -- exact / prefix / contains on the keyword
             case when lower(b.keyword) = tok then 1.00
                  when lower(b.keyword) like tok || '%' then 0.90
                  when lower(b.keyword) like '%' || tok || '%' then 0.80
                  else 0 end,
             -- the English translation, so an English word finds a
             -- German or Norwegian keyword
             case when b.keyword_en is not null and lower(b.keyword_en) like '%' || tok || '%' then 0.75 else 0 end,
             -- structured values people type as words
             case when lower(b.country_code) = tok then 0.85
                  when lower(coalesce(b.country_name, '')) like tok || '%' then 0.85
                  when lower(coalesce(b.status, '')) = tok then 0.70
                  when lower(coalesce(b.search_engine, '')) = tok then 0.70
                  when lower(coalesce(b.scrape_source, '')) = tok then 0.65
                  when lower(coalesce(b.language, '')) = tok then 0.60
                  when lower(coalesce(b.view_mode, '')) = tok then 0.60
                  when lower(coalesce(b.enrichment_status, '')) = tok then 0.60
                  else 0 end,
             -- owner
             case when lower(coalesce(b.created_by_display, '')) like '%' || tok || '%'
                    or lower(coalesce(b.created_by_username, '')) like '%' || tok || '%' then 0.70
                  else 0 end,
             -- batch number
             case when tok ~ '^\d+$' and b.batch_id = tok::bigint then 0.95 else 0 end,
             -- a website this batch actually found; substring first, then
             -- fuzzy, so "jadalliya" still reaches jadaliyya.com
             coalesce((
               select greatest(
                        max(case when lower(l.domain) like '%' || tok || '%' then 0.78 else 0 end),
                        max(similarity(lower(coalesce(l.domain, '')), tok)) * 0.60
                      )
               from public.google_lead_gen_table l
               where l.scrape_job_id = b.id
                 and l.domain is not null
                 and (lower(l.domain) like '%' || tok || '%'
                      or similarity(lower(l.domain), tok) > public.job_search_threshold())
             ), 0),
             -- last resort: a near-miss on the keyword itself
             case when similarity(lower(b.keyword), tok) > public.job_search_threshold()
                  then similarity(lower(b.keyword), tok) * 0.65 else 0 end,
             -- and on the error text, for "timeout", "captcha" and friends
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
    -- No query at all: the structured filters alone define the result.
    where (select coalesce(array_length(t, 1), 0) from tokens) = 0
       or s.score > 0
  ),
  counted as (
    select k.*, count(*) over () as total_count from kept k
  )
  select
    c.job_id,
    coalesce(c.score, 0)::real,
    -- A short, human "why". Recomputed only for the page being returned.
    (
      select array_remove(array[
        case when lower(b2.keyword) like '%' || lower(btrim(coalesce(p_query, ''))) || '%'
                  and btrim(coalesce(p_query, '')) <> '' then 'keyword' end,
        case when b2.keyword_en is not null and btrim(coalesce(p_query, '')) <> ''
                  and lower(b2.keyword_en) like '%' || lower(btrim(p_query)) || '%' then 'english keyword' end,
        case when exists (
               select 1 from public.google_lead_gen_table l
               where l.scrape_job_id = b2.id and l.domain is not null
                 and btrim(coalesce(p_query, '')) <> ''
                 and (lower(l.domain) like '%' || lower(btrim(p_query)) || '%'
                      or similarity(lower(l.domain), lower(btrim(p_query))) > public.job_search_threshold())
             ) then 'a website it found' end,
        case when c.score < 0.80 and c.score > 0 then 'close match' end
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

/** Distinct values the advanced-search form offers, in one round trip. */
create or replace function public.job_search_facets()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'countries', (
      select coalesce(jsonb_agg(jsonb_build_object('code', country_code, 'name', country_name) order by country_name), '[]'::jsonb)
      from public.gologin_profiles where is_active
    ),
    'engines', (
      select coalesce(jsonb_agg(distinct search_engine), '[]'::jsonb)
      from public.scrape_queue where search_engine is not null
    ),
    'statuses', (
      select coalesce(jsonb_agg(distinct status), '[]'::jsonb)
      from public.scrape_queue where status is not null
    ),
    'sources', (
      select coalesce(jsonb_agg(distinct scrape_source), '[]'::jsonb)
      from public.scrape_queue where scrape_source is not null
    ),
    'owners', (
      select coalesce(jsonb_agg(o order by o->>'label'), '[]'::jsonb) from (
        select distinct jsonb_build_object(
          'email', lower(created_by_email),
          'label', coalesce(created_by_display, created_by_username, split_part(created_by_email, '@', 1))
        ) as o
        from public.scrape_queue where created_by_email is not null
      ) s
    )
  );
$$;

grant execute on function public.job_search_facets() to service_role;
revoke execute on function public.job_search_facets() from anon, authenticated;
