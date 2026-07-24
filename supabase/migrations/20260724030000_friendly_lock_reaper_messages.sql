-- ============================================================
-- Friendlier lock-reaper error messages.
--
-- Users saw these two messages yesterday and were confused:
--   "Worker timed out (lock held > 30 min)"
--   "Captcha checkpoint expired without operator action — orphaned
--    lock reclaimed after 30 min. Open the row menu and click
--    'Try again' to re-queue."
--
-- Rewrites the same release_stale_locks(integer) function that
-- migration 20260715150000 last touched, with:
--   - plain-English "the scrape hit its time limit" wording
--   - action guidance for the user ("Click Retry")
--   - no "lock", "reaper", "orphaned" jargon
--
-- Zero behavior change — only text.
-- ============================================================

create or replace function public.release_stale_locks(p_max_age_minutes integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock       record;
  v_count      integer := 0;
  v_status     text;
  v_has_live   boolean;
begin
  for v_lock in (
    select job_id, job_kind, country_code, worker_id, locked_at
    from public.active_profile_locks
    where locked_at < now() - (p_max_age_minutes || ' minutes')::interval
  ) loop

    if v_lock.job_kind = 'scrape' then
      select status into v_status
      from public.scrape_queue
      where id = v_lock.job_id;

      if v_status = 'needs_human' then
        select exists (
          select 1 from public.interactive_checkpoints
          where job_id = v_lock.job_id
            and status = 'waiting'
            and expires_at > now()
        ) into v_has_live;

        if coalesce(v_has_live, false) then
          continue;
        end if;

        update public.scrape_queue
        set status        = 'captcha',
            completed_at  = now(),
            claimed_by    = null,
            error_message = 'The captcha waiting for a human was not solved in time (waited '
                            || p_max_age_minutes || ' min). Click Retry on this row to run it again.',
            updated_at    = now()
        where id = v_lock.job_id and status = 'needs_human';

        delete from public.active_profile_locks where job_id = v_lock.job_id;
        v_count := v_count + 1;
        continue;
      end if;

      update public.scrape_queue
      set status        = case when attempts < max_attempts then 'pending' else 'failed' end,
          claimed_by    = null,
          started_at    = null,
          error_message = 'The scrape did not finish within '
                          || p_max_age_minutes || ' min and was stopped. Usually a stuck browser or a slow site — click Retry to run it again with a fresh session.',
          updated_at    = now()
      where id = v_lock.job_id and status = 'running';

    elsif v_lock.job_kind = 'enrichment' then
      update public.enrichment_fetch_queue
      set status        = case when attempts < max_attempts then 'pending' else 'failed' end,
          claimed_by    = null,
          started_at    = null,
          error_message = 'Lead enrichment did not finish within '
                          || p_max_age_minutes || ' min and was stopped. Retry from the row menu.',
          updated_at    = now()
      where id = v_lock.job_id and status = 'running';
    end if;

    delete from public.active_profile_locks where job_id = v_lock.job_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.release_stale_locks(integer) to service_role;
revoke execute on function public.release_stale_locks(integer) from anon, authenticated;
