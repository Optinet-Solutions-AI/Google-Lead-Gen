-- ============================================================
-- Migration: extend contact_table.source enum
--
-- Adds the new source values produced by the multi-tier cascade:
--   regex       — homepage HTML, regex-based (existing)
--   multi_page  — homepage + /contact /about /impressum, regex
--   openai      — GPT-4o + web_search tool
--   hunter      — Hunter.io domain-search fallback
--   claude      — kept for forward-compat if we ever swap providers
--   manual      — user-edited (existing)
-- ============================================================

alter table public.contact_table
  drop constraint if exists contact_table_source_check;

alter table public.contact_table
  add constraint contact_table_source_check
  check (source in ('regex', 'multi_page', 'openai', 'claude', 'hunter', 'manual'));
