-- ============================================================
-- Soft claim lock on interactive_checkpoints.
--
-- When multiple ops users have the /admin/interactive page open at the
-- same time, two of them could click "Open VNC" on the same captcha,
-- both connect to the live Chromium, and one will type over the
-- other's input. Even when they don't fight, it's wasted effort.
--
-- This migration lets one user "claim" a checkpoint when they click
-- Open VNC. The claim expires automatically after CLAIM_TTL minutes
-- (default 8 — long enough for a human to solve a captcha + a buffer,
-- short enough that a walked-away operator can't park the queue
-- indefinitely).
--
-- Claim lifecycle:
--   1. Open VNC click → claim_interactive_checkpoint() RPC.
--      Atomic UPDATE locks the row to the calling user.
--   2. While the claim is active, other users see the card showing
--      "Solving by X — Ym left" with no Open-VNC / Resume / Cancel
--      buttons.
--   3. The claimer hits Resume or Cancel → checkpoint status flips to
--      'resolved' / 'cancelled' (existing RPCs), claim becomes moot.
--   4. If 8 min elapse with no resolution, the claim auto-expires —
--      computed lazily via claim_expires_at, no cron needed.
-- ============================================================

alter table public.interactive_checkpoints
  add column if not exists claimed_by_user_id  uuid references auth.users(id),
  add column if not exists claimed_by_display  text,
  add column if not exists claimed_at          timestamptz,
  add column if not exists claim_expires_at    timestamptz;

create index if not exists idx_interactive_checkpoints_active_claim
  on public.interactive_checkpoints (claim_expires_at)
  where claim_expires_at is not null;

-- ------------------------------------------------------------
-- RPC: claim_interactive_checkpoint
-- Atomically takes the claim for the calling user when the row is in
-- 'waiting' status AND (unclaimed OR claim already expired OR mine).
-- Re-taking my own claim is a no-op refresh (extends the TTL).
--
-- Returns one row:
--   ok               — true if the caller now holds the claim
--   reason           — null on ok; 'claimed_by_other' / 'not_waiting'
--                      / 'not_found' / 'forbidden' otherwise
--   claimed_by_uid   — current claim holder (caller on ok, other on conflict)
--   claimed_by_display — display name of holder
--   claim_expires_at — when the active claim auto-releases
-- ------------------------------------------------------------
create or replace function public.claim_interactive_checkpoint(
  p_id            bigint,
  p_user_id       uuid,
  p_display       text,
  p_ttl_minutes   integer default 8
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

revoke execute on function public.claim_interactive_checkpoint(bigint, uuid, text, integer)
  from public, anon;
grant execute on function public.claim_interactive_checkpoint(bigint, uuid, text, integer)
  to authenticated, service_role;

-- ------------------------------------------------------------
-- RPC: release_interactive_checkpoint
-- Releases the claim if I own it. Called when the operator closes
-- the noVNC tab via a navigator.sendBeacon (best-effort) or chooses
-- "I'm done, didn't solve" explicitly. No-op when I'm not the holder
-- or the row isn't 'waiting' (e.g. someone resumed it in the meantime).
-- ------------------------------------------------------------
create or replace function public.release_interactive_checkpoint(
  p_id      bigint,
  p_user_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.interactive_checkpoints
     set claimed_by_user_id = null,
         claimed_by_display = null,
         claimed_at         = null,
         claim_expires_at   = null,
         updated_at         = now()
   where id = p_id
     and status = 'waiting'
     and claimed_by_user_id = p_user_id;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke execute on function public.release_interactive_checkpoint(bigint, uuid)
  from public, anon;
grant execute on function public.release_interactive_checkpoint(bigint, uuid)
  to authenticated, service_role;
