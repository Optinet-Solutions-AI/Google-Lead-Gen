-- ============================================================
-- Make search_website_on_monday fast in BULK so the rematch stops timing out.
--
-- The RPC has 6 tiers; tiers 1-5 compare a per-lead value against an expression
-- over every board item — but those expressions (normalize_domain(name),
-- registered_domain(website_normalized), registered_domain(normalize_domain(name)),
-- brand_stem(website_normalized)) had NO indexes, so each lead triggered a
-- function-scan over 7,300+ affiliate rows (× 4 boards). At scrape time (a
-- handful of leads) that's fine, but rematch_monday_for_all_leads(50k) is
-- O(leads × items) and blows the statement timeout — so freshly-synced Monday
-- data never reached existing leads (a hidden driver of recurring "Not on
-- Monday"). Tier 6 (mentioned_in_updates) is already GIN-indexed.
--
-- All three helpers are IMMUTABLE + parallel safe, so we can index the exact
-- tier expressions. In a nested-loop against the single-row `n` CTE the planner
-- can now do index lookups instead of seq scans. Indexes are tiny (a few
-- thousand rows/board) and created plainly (fast, brief lock on small tables).
-- ============================================================

-- Tier 1 (exact website), tier 3 (registered website), tier 5 (brand stem)
create index if not exists idx_affiliates_website_norm       on public.affiliates_table (website_normalized);
create index if not exists idx_affiliates_reg_web            on public.affiliates_table (registered_domain(website_normalized));
create index if not exists idx_affiliates_stem_web           on public.affiliates_table (brand_stem(website_normalized));
-- Tier 2 (name), tier 4 (registered name)
create index if not exists idx_affiliates_name_nd            on public.affiliates_table (normalize_domain(name));
create index if not exists idx_affiliates_reg_name           on public.affiliates_table (registered_domain(normalize_domain(name)));

create index if not exists idx_leads_website_norm            on public.leads_table (website_normalized);
create index if not exists idx_leads_reg_web                 on public.leads_table (registered_domain(website_normalized));
create index if not exists idx_leads_stem_web                on public.leads_table (brand_stem(website_normalized));
create index if not exists idx_leads_name_nd                 on public.leads_table (normalize_domain(name));
create index if not exists idx_leads_reg_name                on public.leads_table (registered_domain(normalize_domain(name)));

create index if not exists idx_nrl_website_norm              on public.not_relevant_leads_table (website_normalized);
create index if not exists idx_nrl_reg_web                   on public.not_relevant_leads_table (registered_domain(website_normalized));
create index if not exists idx_nrl_stem_web                  on public.not_relevant_leads_table (brand_stem(website_normalized));
create index if not exists idx_nrl_name_nd                   on public.not_relevant_leads_table (normalize_domain(name));
create index if not exists idx_nrl_reg_name                  on public.not_relevant_leads_table (registered_domain(normalize_domain(name)));

create index if not exists idx_eul_website_norm              on public.email_undelivered_leads_table (website_normalized);
create index if not exists idx_eul_reg_web                   on public.email_undelivered_leads_table (registered_domain(website_normalized));
create index if not exists idx_eul_stem_web                  on public.email_undelivered_leads_table (brand_stem(website_normalized));
create index if not exists idx_eul_name_nd                   on public.email_undelivered_leads_table (normalize_domain(name));
create index if not exists idx_eul_reg_name                  on public.email_undelivered_leads_table (registered_domain(normalize_domain(name)));

analyze public.affiliates_table;
analyze public.leads_table;
analyze public.not_relevant_leads_table;
analyze public.email_undelivered_leads_table;
