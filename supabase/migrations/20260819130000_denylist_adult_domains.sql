-- ============================================================
-- Auto-flag adult / porn domains as not relevant.
--
-- Charisse: casino SERPs (esp. Bing) surface porn sites — e.g. xnxx.com showed
-- up as "leads" on an IT casino scrape. They're pure noise. Reuse the operator
-- denylist mechanism (flag_operator_denylist_for_job runs in the enrichment
-- chain) so these are auto-set is_not_relevant on every future scrape, then
-- backfill the ones already in the table.
-- ============================================================

insert into public.operator_domains_denylist (host_suffix, added_by, note) values
  ('xnxx.com','seed','adult'), ('xnxx.tv','seed','adult'), ('xvideos.com','seed','adult'),
  ('pornhub.com','seed','adult'), ('xhamster.com','seed','adult'), ('redtube.com','seed','adult'),
  ('youporn.com','seed','adult'), ('spankbang.com','seed','adult'), ('tube8.com','seed','adult'),
  ('brazzers.com','seed','adult'), ('chaturbate.com','seed','adult'), ('stripchat.com','seed','adult'),
  ('livejasmin.com','seed','adult'), ('eporner.com','seed','adult'), ('hqporner.com','seed','adult'),
  ('txxx.com','seed','adult'), ('beeg.com','seed','adult'), ('thumbzilla.com','seed','adult'),
  ('porn.com','seed','adult'), ('porntrex.com','seed','adult'), ('youjizz.com','seed','adult'),
  ('motherless.com','seed','adult'), ('nudevista.com','seed','adult'), ('fapello.com','seed','adult'),
  ('onlyfans.com','seed','adult')
on conflict (host_suffix) do nothing;

-- Backfill: flag existing leads on these adult domains (respecting manual flags).
update public.google_lead_gen_table g
set is_not_relevant        = true,
    not_relevant_marked_at = coalesce(g.not_relevant_marked_at, now()),
    not_relevant_marked_by = coalesce(g.not_relevant_marked_by, 'operator_denylist')
from public.operator_domains_denylist d
where d.note = 'adult'
  and g.is_not_relevant = false
  and (lower(g.domain) like '%//' || d.host_suffix or lower(g.domain) like '%.' || d.host_suffix);
