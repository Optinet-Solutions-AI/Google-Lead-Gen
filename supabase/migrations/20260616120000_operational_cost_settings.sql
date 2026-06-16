-- ============================================================
-- Seed system_settings keys backing the new /admin/operations
-- page so we can show a live operational-cost view.
--
-- The bandwidth tracker (20260601130000_proxy_bandwidth) already
-- captures usage; what was missing was the per-GB rate to turn
-- bytes into dollars, plus the fixed monthly subscriptions
-- (EC2 / GoLogin / Supabase / Vercel / EnigmaProxy base) that
-- make up the rest of OpEx. Everything is admin-editable from the
-- new page via the existing set_system_setting RPC, so the rates
-- don't ship in code and don't need a redeploy to update.
--
-- Defaults are 0 so the page starts at "fill these in" rather
-- than misleading the operator with made-up numbers. Currency is
-- USD across the board; we treat the per-GB rate as a decimal
-- string in jsonb to avoid float drift.
-- ============================================================

insert into public.system_settings (key, value)
values
  -- Variable cost: how much EnigmaProxy charges per GB of
  -- residential bandwidth. Multiplied against the consumption
  -- delta computed from proxy_bandwidth_snapshots.
  ('proxy_bandwidth_cost_usd_per_gb',  '0'::jsonb),
  -- Fixed monthly costs (US dollars per month, decimal string).
  -- One key per line item so the form on /admin/operations can
  -- edit them independently and the activity log records exactly
  -- which one moved.
  ('fixed_cost_ec2_monthly_usd',       '0'::jsonb),
  ('fixed_cost_gologin_monthly_usd',   '0'::jsonb),
  ('fixed_cost_supabase_monthly_usd',  '0'::jsonb),
  ('fixed_cost_vercel_monthly_usd',    '0'::jsonb),
  ('fixed_cost_other_monthly_usd',     '0'::jsonb)
on conflict (key) do nothing;
