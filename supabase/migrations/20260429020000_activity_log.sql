-- ============================================================
-- Migration: activity_log
--
-- Tracks every meaningful action a signed-in user takes through
-- the dashboard. Read-only audit trail — populated only by server
-- actions, never directly by clients.
--
-- Action naming uses a dotted scheme:
--   scrape.enqueue
--   enrichment.affiliate / .rooster / .contact / .stag / .stag_dup_check / .monday_dup_check
--   override.monday / .affiliate / .rooster / .contact / .stag / .stag_verified
--   brand.add / .update / .delete / .toggle_active
--   schedule.create / .update / .delete / .toggle_active / .run_now
--   profile.set_logged_in / .set_requires_login / .set_notes
--   screenshot.delete
-- ============================================================

create table if not exists public.activity_log (
  id           bigint      generated always as identity primary key,
  user_id      uuid,
  user_email   text,
  action       text        not null,
  entity_type  text,
  entity_id    text,
  details      jsonb,
  created_at   timestamptz not null default now()
);

alter table public.activity_log enable row level security;

create index if not exists idx_activity_log_created_at
  on public.activity_log (created_at desc);

create index if not exists idx_activity_log_action
  on public.activity_log (action);

create index if not exists idx_activity_log_entity
  on public.activity_log (entity_type, entity_id);

create index if not exists idx_activity_log_user
  on public.activity_log (user_id)
  where user_id is not null;
