-- ============================================================
-- Rename HITL -> Captcha solver across system_settings keys and
-- public SQL functions. Keep the old keys and function name alive
-- as thin shims during the code-deploy window so reads/writes
-- against the legacy names keep working until Vercel and the VM
-- workers all roll over to the new names.
--
-- A bidirectional sync trigger on system_settings keeps the legacy
-- and new key/value rows in lockstep -- flipping either one
-- mirrors to the other -- so the /admin/system toggle stays
-- effective regardless of which key a given reader looks at during
-- the cutover.
--
-- A follow-up migration will drop the legacy keys, the sync
-- trigger, and the legacy function shim once nothing references
-- them.
-- ============================================================

-- 1) Seed new keys mirroring the current legacy values.
--    Idempotent: re-running just refreshes the value from the
--    legacy row.
insert into public.system_settings (key, value, updated_at)
select 'captcha_solver_enabled',
       coalesce((select value from public.system_settings where key = 'hitl_enabled'),
                'true'::jsonb),
       now()
on conflict (key) do update
   set value      = excluded.value,
       updated_at = excluded.updated_at;

insert into public.system_settings (key, value, updated_at)
select 'captcha_solver_ttl_minutes',
       coalesce((select value from public.system_settings where key = 'hitl_ttl_minutes'),
                '5'::jsonb),
       now()
on conflict (key) do update
   set value      = excluded.value,
       updated_at = excluded.updated_at;

-- 2) Bidirectional sync. pg_trigger_depth() guard breaks the
--    inevitable self-recursion when the trigger updates the
--    partner row. `is distinct from` short-circuits no-op writes
--    so we don't churn updated_at on every flip.
create or replace function public._sync_hitl_captcha_solver_keys()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.key = 'hitl_enabled' then
    update public.system_settings
       set value = new.value, updated_at = now()
     where key  = 'captcha_solver_enabled'
       and value is distinct from new.value;
  elsif new.key = 'captcha_solver_enabled' then
    update public.system_settings
       set value = new.value, updated_at = now()
     where key  = 'hitl_enabled'
       and value is distinct from new.value;
  elsif new.key = 'hitl_ttl_minutes' then
    update public.system_settings
       set value = new.value, updated_at = now()
     where key  = 'captcha_solver_ttl_minutes'
       and value is distinct from new.value;
  elsif new.key = 'captcha_solver_ttl_minutes' then
    update public.system_settings
       set value = new.value, updated_at = now()
     where key  = 'hitl_ttl_minutes'
       and value is distinct from new.value;
  end if;

  return new;
end;
$$;

drop trigger if exists system_settings_sync_hitl_captcha_solver on public.system_settings;
create trigger system_settings_sync_hitl_captcha_solver
after insert or update on public.system_settings
for each row execute function public._sync_hitl_captcha_solver_keys();

-- 3) Canonical function under the new name. Body matches
--    requeue_scrape_after_hitl from
--    20260519050000_requeue_after_hitl_admin_gate.sql.
create or replace function public.requeue_scrape_after_captcha_solver(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_prior_status text;
  v_caller_uid   uuid := auth.uid();
begin
  if v_caller_uid is not null and not public.is_admin(v_caller_uid) then
    raise exception 'admin access required to re-queue scrape jobs'
      using errcode = '42501';
  end if;

  select status into v_prior_status
  from public.scrape_queue
  where id = p_job_id;

  if v_prior_status is null then
    raise exception 'scrape_queue row % not found', p_job_id using errcode = 'P0002';
  end if;

  if v_prior_status not in ('captcha', 'failed', 'cancelled', 'needs_human') then
    raise exception 'cannot re-queue job in status %', v_prior_status using errcode = '22023';
  end if;

  update public.scrape_queue
  set status            = 'pending',
      claimed_by        = null,
      started_at        = null,
      completed_at      = null,
      error_message     = null,
      attempts          = 0,
      captcha_attempts  = 0,
      updated_at        = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;

  return coalesce(v_prior_status, 'unknown');
end;
$$;

revoke execute on function public.requeue_scrape_after_captcha_solver(uuid) from public, anon, authenticated;
grant execute on function public.requeue_scrape_after_captcha_solver(uuid) to service_role;

-- 4) Legacy function name kept as a thin shim. Once all server
--    actions are pointed at the new name (this same deploy), a
--    follow-up migration can drop this.
create or replace function public.requeue_scrape_after_hitl(p_job_id uuid)
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select public.requeue_scrape_after_captcha_solver(p_job_id);
$$;

revoke execute on function public.requeue_scrape_after_hitl(uuid) from public, anon, authenticated;
grant execute on function public.requeue_scrape_after_hitl(uuid) to service_role;

-- 5) Refresh the user-visible default error message in
--    mark_scrape_job_captcha_terminal to say "Captcha solver".
--    Body is otherwise identical to
--    20260522030000_rename_hitl_in_captcha_terminal_default.sql.
create or replace function public.mark_scrape_job_captcha_terminal(
  p_job_id uuid,
  p_error  text default null
) returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.scrape_queue
  set status        = 'captcha',
      completed_at  = now(),
      claimed_by    = null,
      error_message = coalesce(
        p_error,
        'A captcha appeared and nobody was around to solve it. Click "Re-queue with Captcha solver" on the Interactive page to try again.'
      ),
      updated_at    = now()
  where id = p_job_id
    and status in ('running', 'needs_human');

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

revoke execute on function public.mark_scrape_job_captcha_terminal(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_scrape_job_captcha_terminal(uuid, text) to service_role;
