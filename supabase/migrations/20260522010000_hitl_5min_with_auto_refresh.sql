-- ============================================================
-- 20260522010000_hitl_5min_with_auto_refresh.sql
--
-- Aligns HITL and soft-claim TTLs to 5 minutes for the new
-- auto-refresh flow in scraper.py:
--
--   1. system_settings.hitl_ttl_minutes: 2 -> 5
--      Worker reads this per checkpoint to decide how long to
--      wait for an operator. The refresh-loop wrapper in
--      scraper.py runs up to CHECKPOINT_MAX_REFRESH_ATTEMPTS (10)
--      cycles of this TTL before emitting RESULT_MARKER_HITL_TIMEOUT
--      and going terminal.
--
--   2. claim_interactive_checkpoint default p_ttl_minutes: 8 -> 5
--      Soft-claim TTL must not outlast a checkpoint cycle. If the
--      claim is 8 min but the checkpoint times out after 5 min and
--      auto-refreshes into a fresh checkpoint, a stale 8-min claim
--      would block the next solver for ~3 min on the new row.
-- ============================================================

-- 1) Bump the live HITL TTL. The seed row exists since
-- 20260519030000_hitl_short_ttl_and_requeue.sql, but use upsert
-- for safety if it ever got deleted.
insert into public.system_settings (key, value, updated_at)
values ('hitl_ttl_minutes', '5'::jsonb, now())
on conflict (key) do update
   set value      = excluded.value,
       updated_at = excluded.updated_at;

-- 2) Re-create claim_interactive_checkpoint with default 5 instead
-- of 8. Body is unchanged from 20260522000000_interactive_checkpoint_claim.sql.
create or replace function public.claim_interactive_checkpoint(
  p_id            bigint,
  p_user_id       uuid,
  p_display       text,
  p_ttl_minutes   integer default 5
)
returns table(
  ok               boolean,
  reason           text,
  claimed_by_uid   uuid,
  claimed_by_display text,
  claim_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row            public.interactive_checkpoints;
  v_now            timestamptz := now();
  v_new_expires    timestamptz := v_now + make_interval(mins => greatest(1, p_ttl_minutes));
begin
  if p_user_id is null then
    return query select false, 'forbidden'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- Fetch current state first so we can return precise conflict info.
  select * into v_row from public.interactive_checkpoints where id = p_id;
  if v_row.id is null then
    return query select false, 'not_found'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if v_row.status <> 'waiting' then
    return query
      select false, 'not_waiting'::text,
             v_row.claimed_by_user_id, v_row.claimed_by_display, v_row.claim_expires_at;
    return;
  end if;

  -- Take or refresh the claim if unclaimed / expired / mine.
  if v_row.claimed_by_user_id is null
     or v_row.claim_expires_at is null
     or v_row.claim_expires_at < v_now
     or v_row.claimed_by_user_id = p_user_id then
    update public.interactive_checkpoints
       set claimed_by_user_id = p_user_id,
           claimed_by_display = p_display,
           claimed_at         = v_now,
           claim_expires_at   = v_new_expires,
           updated_at         = v_now
     where id = p_id;
    return query
      select true, null::text, p_user_id, p_display, v_new_expires;
    return;
  end if;

  -- Someone else holds an active claim.
  return query
    select false, 'claimed_by_other'::text,
           v_row.claimed_by_user_id, v_row.claimed_by_display, v_row.claim_expires_at;
end;
$$;

-- Grants are unchanged but re-stated for completeness (idempotent).
revoke execute on function public.claim_interactive_checkpoint(bigint, uuid, text, integer)
  from public, anon;
grant execute on function public.claim_interactive_checkpoint(bigint, uuid, text, integer)
  to authenticated, service_role;
