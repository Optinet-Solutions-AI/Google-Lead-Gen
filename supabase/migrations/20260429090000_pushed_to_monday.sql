-- ============================================================
-- Migration: Track manually-pushed leads on Monday.com
--
-- Distinct from `is_on_monday` (which means "we found this domain on
-- the Monday replica boards") — these columns record that the user
-- explicitly clicked "Push to Monday" on a specific lead and we
-- successfully created the item on the Leads board.
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists pushed_to_monday_at    timestamptz,
  add column if not exists monday_pushed_item_id  text,
  add column if not exists monday_pushed_by       text;

create index if not exists idx_glg_pushed_to_monday
  on public.google_lead_gen_table (pushed_to_monday_at desc)
  where pushed_to_monday_at is not null;
