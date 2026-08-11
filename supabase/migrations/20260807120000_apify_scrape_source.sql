-- ============================================================
-- New-batch flow: Google splits into an Apify organic job (captcha-free,
-- ships first) + a VM/GoLogin PPC job (background). This migration adds the
-- data model; it changes NOTHING until the enqueue action starts creating
-- 'apify' jobs, so it is safe to ship ahead of the worker + enqueue changes.
-- ============================================================

-- How a job is run: 'vm' = GoLogin/Selenium (default, every existing row),
-- 'apify' = organic via the Apify Google SERP API (worker routes on this).
alter table public.scrape_queue
  add column if not exists scrape_source text not null default 'vm';
alter table public.scrape_queue
  drop constraint if exists scrape_queue_scrape_source_check;
alter table public.scrape_queue
  add constraint scrape_queue_scrape_source_check check (scrape_source in ('vm', 'apify'));

-- Links the organic(apify) + ppc(vm) halves of one user batch so the UI can
-- group them and show "organic ready · PPC scraping/queued".
alter table public.scrape_queue
  add column if not exists batch_group_id uuid;
create index if not exists idx_scrape_queue_batch_group
  on public.scrape_queue (batch_group_id) where batch_group_id is not null;

-- DB-backed Apify token (survives VM redeploys, same pattern as the 2captcha
-- key). Seeded empty; the real value is set out-of-band, never committed.
insert into public.system_settings (key, value)
values ('apify_api_token', '""'::jsonb)
on conflict (key) do nothing;

-- Quota: a split Google batch = 1 apify(organic) + 1 vm(ppc). Count ONLY the
-- vm job so the batch costs the user ONE scrape, not two. Non-split / legacy
-- jobs default scrape_source='vm', so they count exactly as before.
create or replace function public.count_user_scrapes_today(p_email text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.scrape_queue
  where lower(coalesce(created_by_email, '')) = lower(coalesce(p_email, ''))
    and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    and parent_scrape_job_id is null
    and coalesce(is_rerun, false) = false
    and coalesce(scrape_source, 'vm') <> 'apify'
$$;
grant execute on function public.count_user_scrapes_today(text) to service_role, authenticated;
