-- ============================================================
-- Migration: claim-ownership check on resolve / cancel
--
-- The 8-min soft claim shipped in 20260522000000 protected Open VNC
-- atomically but left a server-side gap: resolve_interactive_checkpoint
-- and cancel_interactive_checkpoint only checked `status = 'waiting'`
-- and ignored claim ownership. A stale /admin/interactive tab could
-- POST a Resume out from under the operator who actually held the
-- VNC session.
--
-- This migration:
--   1. Drops the prior (bigint, text, text) signatures to avoid an
--      ambiguous overload.
--   2. Reintroduces both RPCs with an extra p_user_id uuid argument
--      and a structured (ok, reason, claimed_by_display) return so
--      the server action can surface "Locked — Charisse is solving it"
--      to the loser instead of silently dropping the click.
--   3. Allows the caller through when the claim is vacant, expired,
--      or theirs. Anyone else trying to Resume / Cancel during an
--      active foreign claim is rejected with reason='claimed_by_other'.
-- ============================================================

drop function if exists public.resolve_interactive_checkpoint(bigint, text, text);
drop function if exists public.cancel_interactive_checkpoint(bigint, text, text);

-- ------------------------------------------------------------
-- resolve_interactive_checkpoint — Resume button
-- ------------------------------------------------------------
create or replace function public.resolve_interactive_checkpoint(
  p_id      bigint,
  p_user_id uuid,
  p_note    text default null,
  p_user    text default null
)
returns table(
  ok                 boolean,
  reason             text,
  claimed_by_display text
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row    public.interactive_checkpoints;
  v_job_id uuid;
begin
  select * into v_row from public.interactive_checkpoints where id = p_id;
  if v_row.id is null then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if v_row.status <> 'waiting' then
    return query select false, 'not_waiting'::text, v_row.claimed_by_display;
    return;
  end if;
  -- Caller must own the claim, or the claim must be vacant / expired.
  if v_row.claimed_by_user_id is not null
     and v_row.claimed_by_user_id <> p_user_id
     and v_row.claim_expires_at is not null
     and v_row.claim_expires_at > now() then
    return query select false, 'claimed_by_other'::text, v_row.claimed_by_display;
    return;
  end if;

  update public.interactive_checkpoints
  set status          = 'resolved',
      resolution_note = p_note,
      resolved_at     = now(),
      resolved_by     = p_user
  where id = p_id and status = 'waiting'
  returning job_id into v_job_id;

  if v_job_id is not null then
    update public.scrape_queue
    set status = 'running',
        updated_at = now()
    where id = v_job_id and status = 'needs_human';
  end if;

  return query select true, null::text, null::text;
end;
$$;

grant execute on function public.resolve_interactive_checkpoint(bigint, uuid, text, text)
  to service_role;
revoke execute on function public.resolve_interactive_checkpoint(bigint, uuid, text, text)
  from anon, authenticated;

-- ------------------------------------------------------------
-- cancel_interactive_checkpoint — Cancel button
-- ------------------------------------------------------------
create or replace function public.cancel_interactive_checkpoint(
  p_id      bigint,
  p_user_id uuid,
  p_note    text default null,
  p_user    text default null
)
returns table(
  ok                 boolean,
  reason             text,
  claimed_by_display text
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row    public.interactive_checkpoints;
  v_job_id uuid;
begin
  select * into v_row from public.interactive_checkpoints where id = p_id;
  if v_row.id is null then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if v_row.status <> 'waiting' then
    return query select false, 'not_waiting'::text, v_row.claimed_by_display;
    return;
  end if;
  if v_row.claimed_by_user_id is not null
     and v_row.claimed_by_user_id <> p_user_id
     and v_row.claim_expires_at is not null
     and v_row.claim_expires_at > now() then
    return query select false, 'claimed_by_other'::text, v_row.claimed_by_display;
    return;
  end if;

  update public.interactive_checkpoints
  set status          = 'cancelled',
      resolution_note = p_note,
      resolved_at     = now(),
      resolved_by     = p_user
  where id = p_id and status = 'waiting'
  returning job_id into v_job_id;

  if v_job_id is not null then
    update public.scrape_queue
    set status        = 'failed',
        error_message = coalesce(p_note, 'cancelled by operator at human-in-the-loop checkpoint'),
        completed_at  = now(),
        updated_at    = now()
    where id = v_job_id and status = 'needs_human';

    delete from public.active_profile_locks where job_id = v_job_id;
  end if;

  return query select true, null::text, null::text;
end;
$$;

grant execute on function public.cancel_interactive_checkpoint(bigint, uuid, text, text)
  to service_role;
revoke execute on function public.cancel_interactive_checkpoint(bigint, uuid, text, text)
  from anon, authenticated;
