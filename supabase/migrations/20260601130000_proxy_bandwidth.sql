-- ============================================================
-- proxy_bandwidth — track how much proxy data the plan has left.
--
-- The scrapers run through GoLogin-managed residential proxies on a
-- metered plan (Chris's "5 GB" plan). When the plan runs dry, scrapes
-- fail with a "proxy ran out of bandwidth" error (see the classifier in
-- vm/worker.py). Operators had no way to SEE the remaining balance
-- before it hit zero — this feature surfaces it on the dashboard and
-- warns when it gets low.
--
-- Source of truth: GoLogin's proxy traffic-usage API, polled server-side
-- by /api/proxy/bandwidth/refresh (Vercel cron) using the same
-- GOLOGIN_API_TOKEN the workers already use. Each poll writes one
-- snapshot row here; the dashboard reads the latest.
--
-- Scope: a single shared pool (one metered plan), not per-country or
-- per-VM — so there's no proxy/country dimension on the snapshot.
--
-- Units: everything is stored in BYTES. The admin enters the plan size
-- and low-balance threshold in GB on /admin/system; the UI converts
-- using 1 GB = 1024^3 bytes.
-- ============================================================

-- ------------------------------------------------------------
-- Config lives in the existing system_settings key/value table so it
-- reuses get_system_setting / set_system_setting and the /admin/system
-- page. Seed sensible defaults (5 GB plan, warn at 1 GB left) without
-- clobbering any value an admin has already set.
--   proxy_bandwidth_limit_bytes          5 GB = 5 * 1024^3 = 5368709120
--   proxy_bandwidth_low_threshold_bytes  1 GB = 1     * 1024^3 = 1073741824
-- ------------------------------------------------------------
insert into public.system_settings (key, value)
values
  ('proxy_bandwidth_limit_bytes',         '5368709120'::jsonb),
  ('proxy_bandwidth_low_threshold_bytes', '1073741824'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- Snapshot history. One row per successful poll. Keeping history (rather
-- than a single mutable row) is cheap and lets us show a burn-rate /
-- "runs out in ~N days" estimate later, and makes the low-balance
-- transition (was-not-low → now-low) detectable by comparing to the
-- previous row.
-- ------------------------------------------------------------
create table if not exists public.proxy_bandwidth_snapshots (
  id              bigint generated always as identity primary key,
  -- Bytes consumed so far, as reported by GoLogin.
  used_bytes      bigint not null,
  -- Plan allowance at snapshot time. From GoLogin if it reports one,
  -- else the admin-configured proxy_bandwidth_limit_bytes.
  limit_bytes     bigint not null,
  -- Bytes left. From GoLogin if it reports remaining directly, else
  -- max(limit_bytes - used_bytes, 0).
  remaining_bytes bigint not null,
  -- True when remaining_bytes < the configured low threshold at capture.
  is_low          boolean not null default false,
  -- The raw GoLogin response, for debugging unit/field drift.
  raw             jsonb,
  captured_at     timestamptz not null default now()
);

-- The dashboard always wants the most recent row.
create index if not exists proxy_bandwidth_snapshots_captured_at_idx
  on public.proxy_bandwidth_snapshots (captured_at desc);

alter table public.proxy_bandwidth_snapshots enable row level security;

-- Reads: admin-only at the RLS layer (consistent with system_settings).
-- The dashboard card and the poller both go through the service-role
-- client (RLS-bypassing), so every operator still sees the balance on
-- the Overview page — this policy only governs any direct authenticated
-- client query.
drop policy if exists "proxy_bandwidth_snapshots_admin_read" on public.proxy_bandwidth_snapshots;
create policy "proxy_bandwidth_snapshots_admin_read"
  on public.proxy_bandwidth_snapshots for select
  to authenticated
  using (public.is_admin(auth.uid()));
