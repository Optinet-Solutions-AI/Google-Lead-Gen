-- ============================================================
-- Migration: (1) operator "reviewed" flag on scrape jobs, and
--            (2) per-engine "pushed to Monday" tracking columns.
--
-- Two unrelated Darren-requested features bundled into one migration
-- because they both extend the scrape pipeline's existing tables:
--
--   1. scrape_queue.reviewed_at / reviewed_by — a shared (team-wide)
--      flag operators tick on the /scrape Recent-jobs table so everyone
--      can see at a glance which scrapes have already been eyeballed.
--      Mirrors the timestamp+by shape used elsewhere (e.g. captcha,
--      pushed_to_monday) so we record WHO reviewed and WHEN, not just a
--      bare boolean.
--
--   2. pushed_to_monday_at / monday_pushed_item_id / monday_pushed_by on
--      every social-engine entity table. google_lead_gen_table already
--      has these (migration 20260429090000_pushed_to_monday.sql); this
--      extends the same three-column pattern to the 8 newer engines so a
--      job-level "Push to Monday" can stamp each entity it creates an
--      item for and never double-push it.
-- ============================================================

-- ---- (1) Reviewed flag on scrape jobs -----------------------------------
alter table public.scrape_queue
  add column if not exists reviewed_at  timestamptz,
  add column if not exists reviewed_by  text;

comment on column public.scrape_queue.reviewed_at is
  'When an operator marked this scrape as reviewed (NULL = not yet reviewed). Team-wide, not per-user.';
comment on column public.scrape_queue.reviewed_by is
  'Display name of the operator who last toggled the reviewed flag.';

-- ---- (2) Per-engine "pushed to Monday" tracking -------------------------
-- Same three columns added to each entity table so the generic push code
-- can stamp uniformly.
--
-- Guarded per-table with to_regclass: not every engine's table exists in
-- every environment (e.g. twitch_streamers was never applied to prod —
-- Twitch was scaffolded but never fully built), and a bare `alter table`
-- on a missing relation hard-fails the whole migration. The loop simply
-- skips tables that aren't present. `add column if not exists` keeps the
-- per-column adds idempotent so the migration is safe to re-run.
do $$
declare
  t text;
  tables text[] := array[
    'youtube_channels',
    'kick_streamers',
    'twitch_streamers',
    'x_creators',
    'fb_advertisers',
    'tiktok_creators',
    'snapchat_creators',
    'telegram_channels'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'alter table public.%I
           add column if not exists pushed_to_monday_at    timestamptz,
           add column if not exists monday_pushed_item_id  text,
           add column if not exists monday_pushed_by       text',
        t
      );
    else
      raise notice 'skipping %, table does not exist in this environment', t;
    end if;
  end loop;
end $$;
