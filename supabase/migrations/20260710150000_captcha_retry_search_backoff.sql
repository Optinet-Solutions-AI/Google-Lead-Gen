-- ============================================================
-- Pace SEARCH-engine captcha retries so we stop hammering a flagged
-- residential-proxy pool.
--
-- WHY: Bing (and Google) flag our Enigma residential exit IPs when
-- gambling-class queries hit them in quick succession from the same
-- country. The 2026-07-10 fix (commit aa372a5) correctly turns a
-- degraded/soft-blocked Bing SERP into [RESULT] CAPTCHA so the job
-- retries on a fresh proxy instead of silently completing with 0
-- results. But captcha_scrape_job re-queued the retry with NO delay
-- and cleared started_at, so the search_engine_cooldown_seconds gate
-- in claim_scrape_job (which only looks at OTHER jobs' started_at)
-- never spaced a job's own retries. Result: a soft-blocked job
-- re-claimed itself immediately and hammered the proxy pool (observed
-- live: IE/NO/DE jobs burned 5-7 captcha_attempts in ~2 min), which
-- keeps the pool flagged and starves the batch — exactly why Darren's
-- batch of generic AU keywords returned nothing while a lone test
-- keyword recovered on its second attempt.
--
-- WHAT: when captcha_scrape_job re-queues a google/bing job, schedule
-- the retry `search_engine_cooldown_seconds` into the future (via
-- scheduled_at) instead of making it immediately claimable. The
-- per-country lock is still released right away, so OTHER countries /
-- social jobs keep flowing — only THIS job steps back to let the proxy
-- pool cool before its next attempt. Social engines (kick, youtube,
-- tiktok, snapchat, twitch, facebook, telegram, x) keep retrying
-- immediately, unchanged.
--
-- SAFE BY DEFAULT: the backoff reuses the existing
-- search_engine_cooldown_seconds knob. When it is 0 (disabled) there
-- is NO backoff and behaviour is identical to before this migration.
-- Set back to '0' to disable instantly (no redeploy).
--
-- Body is otherwise identical to 20260522020000_friendly_rpc_error_messages.sql.
-- ============================================================

create or replace function public.captcha_scrape_job(p_job_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_max_captcha integer := 10;
  v_attempts    integer;
  v_engine      text;
  v_cooldown    integer := 0;
  v_backoff     interval := interval '0 seconds';
begin
  select coalesce(captcha_attempts, 0), search_engine
    into v_attempts, v_engine
  from public.scrape_queue
  where id = p_job_id;

  v_attempts := v_attempts + 1;

  -- Search engines: space the retry out by the pacing window so we let
  -- flagged proxy IPs cool instead of re-hitting them back-to-back.
  -- Social engines retry immediately (v_backoff stays 0).
  if v_engine in ('google', 'bing') then
    select coalesce((value)::integer, 0)
      into v_cooldown
    from public.system_settings
    where key = 'search_engine_cooldown_seconds';
    if coalesce(v_cooldown, 0) > 0 then
      v_backoff := (v_cooldown || ' seconds')::interval;
    end if;
  end if;

  if v_attempts < v_max_captcha then
    update public.scrape_queue
    set status            = 'pending',
        captcha_attempts  = v_attempts,
        attempts          = 0,
        claimed_by        = null,
        started_at        = null,
        completed_at      = null,
        scheduled_at      = case
                              when v_backoff > interval '0 seconds' then now() + v_backoff
                              else null
                            end,
        error_message     = format(
          'Search engine showed a captcha. Trying again with a fresh proxy IP (attempt %s of %s)%s — no action needed.',
          v_attempts, v_max_captcha,
          case
            when v_backoff > interval '0 seconds'
              then format(' in ~%ss', floor(extract(epoch from v_backoff))::int)
            else ''
          end
        ),
        updated_at        = now()
    where id = p_job_id;
  else
    update public.scrape_queue
    set status            = 'captcha',
        captcha_attempts  = v_attempts,
        completed_at      = now(),
        error_message     = format(
          'Captcha kept appearing after %s tries. Open the row menu and click "Try again" to reset and re-queue.',
          v_attempts
        ),
        updated_at        = now()
    where id = p_job_id;
  end if;

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.captcha_scrape_job(uuid) to service_role;
revoke execute on function public.captcha_scrape_job(uuid) from anon, authenticated;
