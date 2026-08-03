-- ============================================================
-- Contact-extraction v3 — automatic Monday inheritance tick (LGP-222)
--
-- Runs public.inherit_monday_data_batch(200) every 5 minutes so leads
-- newly matched to a Monday item (is_on_monday=true, monday_inherited_at
-- null — set at scrape completion) get their contacts / s-tags /
-- classification inherited without any app involvement. The batch RPC is
-- idempotent and only touches un-inherited leads, so a quiet tick is a
-- no-op. Mirrors the release-stale-scrape-locks cron pattern.
--
-- Requires pg_cron (already enabled for the stale-lock job).
-- Idempotent: unschedules any prior version before re-scheduling.
-- ============================================================

create extension if not exists pg_cron with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'inherit-monday-data') then
    perform cron.unschedule('inherit-monday-data');
  end if;
end
$$;

select cron.schedule(
  'inherit-monday-data',
  '*/5 * * * *',
  $$select public.inherit_monday_data_batch(200)$$
);
