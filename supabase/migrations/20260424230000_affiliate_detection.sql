-- ============================================================
-- Migration: Affiliate Site Detection (Epic 7.2)
--
-- Adds the supporting columns for the heuristic affiliate-site
-- classifier. Source of truth for the algorithm:
--   docs/n8n-workflows-catalog.md §2.3 "Check Affiliate"
--   plus docs/_extracted_affiliate_scorer.js (verbatim n8n JS).
--
-- The `is_affiliate` column already exists from the core migration.
-- We add:
--   - affiliate_score             — total points the site scored
--   - affiliate_casino_score      — casino-side counter-signal
--   - affiliate_confidence        — VERY_HIGH | HIGH | MEDIUM | LOW
--                                   (also 'ERROR' / 'SKIPPED')
--   - affiliate_external_links    — outbound casino-link count
--   - affiliate_indicators        — jsonb array of human-readable
--                                   reasons the score went up/down
--   - affiliate_checked_at        — when the auto-check last ran
--                                   for this row (NULL = never)
--   - is_affiliate_overridden_at  — when the user manually set it,
--                                   so re-runs leave it alone
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists affiliate_score             integer,
  add column if not exists affiliate_casino_score      integer,
  add column if not exists affiliate_confidence        text,
  add column if not exists affiliate_external_links    integer,
  add column if not exists affiliate_indicators        jsonb,
  add column if not exists affiliate_checked_at        timestamptz,
  add column if not exists is_affiliate_overridden_at  timestamptz;

create index if not exists idx_glg_is_affiliate
  on public.google_lead_gen_table (is_affiliate)
  where is_affiliate is not null;

create index if not exists idx_glg_affiliate_checked_at
  on public.google_lead_gen_table (affiliate_checked_at)
  where affiliate_checked_at is not null;
