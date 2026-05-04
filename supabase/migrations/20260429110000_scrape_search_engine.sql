-- ============================================================
-- Migration: Per-job search engine (Google or Bing)
--
-- Bing has different SERP HTML and different country/language
-- query params, but the captured leads are just URLs — every
-- downstream stage (enrichment, redirect resolution, screenshots)
-- treats Bing-sourced and Google-sourced rows the same way.
--
-- Stores the engine the user picked. Default 'google' so existing
-- rows stay correct without a backfill.
-- ============================================================

alter table public.scrape_queue
  add column if not exists search_engine text not null default 'google'
    check (search_engine in ('google', 'bing'));
