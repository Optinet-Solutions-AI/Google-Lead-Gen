-- ============================================================
-- Captcha solve attribution.
--
-- Now that 2Captcha auto-solves most walls, we want /admin/interactive
-- to show WHO cleared each captcha — the bot or a human — and a count
-- of auto-solves. Previously a successful auto-solve left no trace (the
-- scraper just resumed), so there was nothing to attribute.
--
-- 1. resolution_method column tags every resolution: 'human' | 'auto_2captcha'.
-- 2. record_auto_captcha_solve() writes a pre-resolved audit row when
--    2Captcha clears a wall. It does NOT flip the job to needs_human —
--    the scrape is already continuing; this row is purely for visibility.
-- 3. resolve_interactive_checkpoint() stamps 'human' on operator resumes.
-- ============================================================

alter table public.interactive_checkpoints
  add column if not exists resolution_method text
    check (resolution_method in ('human', 'auto_2captcha'));

-- Every existing resolved row predates auto-solve, so it was a human.
update public.interactive_checkpoints
set resolution_method = 'human'
where status = 'resolved' and resolution_method is null;

-- ------------------------------------------------------------
-- record_auto_captcha_solve — scraper calls this after 2Captcha
-- clears a wall. Writes a resolved checkpoint for the audit trail.
-- Deliberately does NOT touch scrape_queue (the scrape is already
-- resuming) and stamps expires_at=now() since it's never "waiting".
-- job_is_shadow is denormalised from the parent job, same as
-- create_interactive_checkpoint, so shadow viewers filter correctly.
-- ------------------------------------------------------------
create or replace function public.record_auto_captcha_solve(
  p_job_id      uuid,
  p_worker_id   text,
  p_worker_port integer,
  p_reason      text default 'captcha',
  p_current_url text default null,
  p_page_title  text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id        bigint;
  v_is_shadow boolean;
begin
  select coalesce(created_by_is_shadow, false) into v_is_shadow
  from public.scrape_queue where id = p_job_id;

  insert into public.interactive_checkpoints
    (job_id, worker_id, worker_port, reason, current_url, page_title,
     status, resolution_method, resolved_by, resolved_at, expires_at,
     job_is_shadow)
  values
    (p_job_id, p_worker_id, p_worker_port, p_reason, p_current_url, p_page_title,
     'resolved', 'auto_2captcha', '2Captcha', now(), now(),
     coalesce(v_is_shadow, false))
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.record_auto_captcha_solve(
  uuid, text, integer, text, text, text
) to service_role;
revoke execute on function public.record_auto_captcha_solve(
  uuid, text, integer, text, text, text
) from anon, authenticated;

-- ------------------------------------------------------------
-- resolve_interactive_checkpoint — re-create the current
-- (bigint, uuid, text, text) signature verbatim + stamp
-- resolution_method='human' on the resume.
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
  if v_row.claimed_by_user_id is not null
     and v_row.claimed_by_user_id <> p_user_id
     and v_row.claim_expires_at is not null
     and v_row.claim_expires_at > now() then
    return query select false, 'claimed_by_other'::text, v_row.claimed_by_display;
    return;
  end if;

  update public.interactive_checkpoints
  set status            = 'resolved',
      resolution_method = 'human',
      resolution_note   = p_note,
      resolved_at       = now(),
      resolved_by       = p_user
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
