-- ============================================================
-- Migration: Rooster Partner Check (Epic 7.3)
--
-- Detects whether an affiliate site already promotes (links out to)
-- one of our Rooster brands. The "Rooster brand whitelist" comes
-- from affiliates_table.website_normalized (the websites listed on
-- our Affiliates Monday board).
--
-- Logic runs in TS (needs HTML), so this migration only adds the
-- supporting columns + a helper to read the brand list cleanly.
--
-- Distinct from 7.1 Monday-duplicate-check:
--   - 7.1 = "this lead's domain IS a Rooster brand we own"
--   - 7.3 = "this lead's site links out to our Rooster brands"
--           (i.e. they're already promoting us — good lead)
--
-- The `is_rooster_partner` and `brand` columns already exist on
-- google_lead_gen_table (from the core migration).
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists rooster_brands             jsonb,
  add column if not exists rooster_checked_at         timestamptz,
  add column if not exists is_rooster_overridden_at   timestamptz;

create index if not exists idx_glg_is_rooster_partner
  on public.google_lead_gen_table (is_rooster_partner)
  where is_rooster_partner is not null;

-- ------------------------------------------------------------
-- list_rooster_brand_domains() — returns the domain whitelist
-- ------------------------------------------------------------
create or replace function public.list_rooster_brand_domains()
returns table(domain text, brand_name text, monday_item_id text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (website_normalized)
         website_normalized as domain,
         coalesce(name, affiliate_name) as brand_name,
         monday_item_id
    from public.affiliates_table
   where website_normalized is not null
     and website_normalized <> ''
   order by website_normalized;
$$;

grant execute on function public.list_rooster_brand_domains() to service_role;
revoke execute on function public.list_rooster_brand_domains() from anon, authenticated;
