-- ============================================================
-- Index the lead-domain expression that complete_scrape_job matches on, so it
-- stops timing out on normal-size scrapes ("results couldn't be saved").
--
-- complete_scrape_job steps (c) memory-inheritance and (d) override-carry-forward
-- each run a per-new-lead lateral over google_lead_gen_table:
--     where normalize_domain(coalesce(p.domain, p.url)) = <this lead's domain>
-- with NO index on that expression → a full seq scan of the whole (100k+ row)
-- table for EVERY lead in the batch. At ~25 leads that's 25× (with step d, 50×)
-- full scans and it exceeds the 8s statement timeout, so the whole job fails
-- with "results couldn't be saved — retrying". Measured: 25-lead
-- complete_scrape_job = timeout at 8.3s. Pre-existing for large batches; step d
-- (20260820120000) made it hit smaller batches too.
--
-- normalize_domain + coalesce are IMMUTABLE, so the exact expression is
-- indexable. With it, both laterals do index lookups instead of seq scans.
-- ============================================================
create index if not exists idx_lead_norm_domain
  on public.google_lead_gen_table (normalize_domain(coalesce(domain, url)));

analyze public.google_lead_gen_table;
