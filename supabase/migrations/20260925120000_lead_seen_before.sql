-- Make "Already exists?" filterable.
--
-- The column shows one of three states — on Monday, in the system, or new —
-- but only the Monday part was ever a real column. "In system" was computed
-- in the page by comparing the profile's first sighting against the lead's
-- own timestamp, so the filter panel had nothing to offer and an operator
-- could see the column but not filter by it.
--
-- The comparison cannot be expressed in PostgREST (it is two columns against
-- each other), and it is immutable once written: a profile's first_seen_at is
-- set once, and a lead's created_at never moves. So store it.
--
-- Only the "was this website already known?" half is stored. The Monday half
-- stays resolved at read time because it genuinely changes — the matcher runs
-- after the scrape, and an operator can override it.

alter table public.google_lead_gen_table
  add column if not exists seen_before boolean;

comment on column public.google_lead_gen_table.seen_before is
  'True when this website already had a profile before this lead was written. The "In system" half of the Already exists? column; immutable once set.';

-- Backfill from the profile's first sighting. The minute of slack stops rows
-- written by the same batch from marking each other as pre-existing.
update public.google_lead_gen_table g
set seen_before = (p.first_seen_at < g.created_at - interval '1 minute')
from public.website_profiles p
where p.id = g.profile_id
  and g.seen_before is null;

-- Leads with no profile at all (should be none) default to "not seen before"
-- rather than staying null, so the filter never silently drops a row.
update public.google_lead_gen_table
set seen_before = false
where seen_before is null;

alter table public.google_lead_gen_table
  alter column seen_before set default false;

-- Partial index: "new" is the interesting, rarer case and the one operators
-- filter for.
create index if not exists idx_leads_seen_before_new
  on public.google_lead_gen_table (created_at desc)
  where seen_before = false;

create index if not exists idx_leads_seen_before
  on public.google_lead_gen_table (seen_before);
