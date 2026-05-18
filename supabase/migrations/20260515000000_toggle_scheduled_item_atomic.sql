-- ============================================================
-- Migration: Atomic toggle for scheduled_keyword_items.is_active
--
-- Bug
-- ---
-- The previous toggle path was a read-modify-write driven by client
-- state: the form posted `is_active=<current value>` and the action
-- wrote the inverse. Two concurrent clicks (or a stale UI tab) would
-- both pass the same `is_active=true` and both write `false`, even
-- though the second click should have re-toggled it back to `true`.
--
-- Fix
-- ---
-- Server-side `NOT is_active` UPDATE wrapped in a SECURITY DEFINER
-- RPC. The DB does the toggle atomically — concurrent calls serialize
-- on the row's lock and each successfully flips the value, with no
-- lost updates.
--
-- Apply with:
--   tsx scripts/db/apply-migration.ts --apply \
--     supabase/migrations/20260515000000_toggle_scheduled_item_atomic.sql
-- (omit --apply for a dry-run preview)
-- ============================================================

create or replace function public.toggle_scheduled_item(p_item_id uuid)
returns table (id uuid, is_active boolean)
language sql
security definer
set search_path = public
as $$
  update scheduled_keyword_items
  set is_active = not is_active
  where id = p_item_id
  returning id, is_active;
$$;

grant execute on function public.toggle_scheduled_item(uuid) to service_role;
