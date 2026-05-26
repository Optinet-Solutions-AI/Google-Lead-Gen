-- ============================================================
-- Migration: English translation of the scrape keyword
--
-- Non-English scrapes (Arabic, German, Norwegian…) leave the QA
-- team guessing what they're reviewing. Store an English
-- translation alongside the original keyword so the detail page
-- can show "كازينو كريبتو عمان موثوق  →  Trusted Oman crypto casino"
-- without re-hitting the translation API on every page view.
--
-- - Nullable: the translation is best-effort. If the Google
--   Translate API key isn't set or the call fails, the column
--   stays NULL and the UI just shows the original.
-- - Skipped when language = 'en' (no point translating EN→EN).
-- - Filled by the enqueue server action at scrape-creation time,
--   with a lazy backfill on first detail-page view for rows
--   queued before this migration.
-- ============================================================

alter table public.scrape_queue
  add column if not exists keyword_en text;
