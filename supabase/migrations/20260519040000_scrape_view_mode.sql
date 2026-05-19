-- ============================================================
-- Per-job view mode: desktop, mobile, or both.
--
-- Previously the scraper always ran the desktop SERP loop and only
-- optionally appended a "mobile PPC sweep" on page 0 — useful for
-- catching mobile-only ads, but no help for mobile-only organic
-- results (which exist when Google ranks differently on mobile, or
-- when the affiliate site hides organic-relevant content under
-- mobile CSS).
--
-- Operators can now pick view_mode per scrape job:
--   'desktop' — desktop pass only (legacy behaviour)
--   'mobile'  — mobile pass only (iPhone UA + 375x812 viewport)
--   'both'    — desktop pass then mobile pass; URLs seen on both
--               sides get seen_on='both', URLs only in mobile get
--               seen_on='mobile', desktop-only stays 'desktop'
--
-- Default is 'both' so existing flows pick up the new behaviour
-- automatically without changing the form's preset.
-- ============================================================

alter table public.scrape_queue
  add column if not exists view_mode text not null default 'both';

alter table public.scrape_queue
  drop constraint if exists scrape_queue_view_mode_check;

alter table public.scrape_queue
  add constraint scrape_queue_view_mode_check
  check (view_mode in ('desktop', 'mobile', 'both'));

create index if not exists idx_scrape_queue_view_mode
  on public.scrape_queue (view_mode)
  where view_mode <> 'desktop';
