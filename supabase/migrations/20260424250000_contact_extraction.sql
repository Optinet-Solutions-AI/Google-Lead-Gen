-- ============================================================
-- Migration: Contact Extraction (Epic 7.4)
--
-- Stores extracted contact details (emails, phones, contact-page URL)
-- for each lead row. Schema mirrors the legacy `contact_table` that
-- the n8n pipeline wrote to.
--
-- First-iteration extractor is regex-based (HTML parse). Future
-- iteration: layer Claude with web_search on top per the catalog
-- recommendations.
--
-- google_lead_gen_table.contact_id (FK) already exists from the
-- core migration. This adds the table it points at + a check timestamp.
-- ============================================================

create table if not exists public.contact_table (
  id                   bigint      generated always as identity primary key,
  lead_id              bigint      not null references public.google_lead_gen_table(id) on delete cascade,
  emails               jsonb,                  -- ["foo@bar.com", ...]
  phones               jsonb,                  -- ["+1 555 1234", ...]
  contact_page_url     text,
  source               text not null default 'regex' check (source in ('regex', 'claude', 'hunter', 'manual')),
  raw                  jsonb,                  -- diagnostic info (which patterns matched, etc.)
  created_at           timestamptz not null default now()
);

alter table public.contact_table enable row level security;

create index if not exists idx_contact_lead_id
  on public.contact_table (lead_id);

alter table public.google_lead_gen_table
  add column if not exists contact_checked_at        timestamptz,
  add column if not exists is_contact_overridden_at  timestamptz;

create index if not exists idx_glg_contact_id
  on public.google_lead_gen_table (contact_id)
  where contact_id is not null;

-- ------------------------------------------------------------
-- upsert_contact_for_lead — atomic; replaces previous auto rows
-- ------------------------------------------------------------
create or replace function public.upsert_contact_for_lead(
  p_lead_id          bigint,
  p_emails           jsonb,
  p_phones           jsonb,
  p_contact_page_url text,
  p_source           text default 'regex',
  p_raw              jsonb default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_contact_id bigint;
begin
  -- Replace any previous auto rows for this lead (manual rows are kept by
  -- only deleting where source <> 'manual').
  delete from public.contact_table
  where lead_id = p_lead_id
    and source <> 'manual';

  insert into public.contact_table (lead_id, emails, phones, contact_page_url, source, raw)
  values (p_lead_id, p_emails, p_phones, p_contact_page_url, p_source, p_raw)
  returning id into v_contact_id;

  update public.google_lead_gen_table
  set contact_id = v_contact_id,
      has_contact_details = (
        coalesce(jsonb_array_length(p_emails), 0) > 0
        or coalesce(jsonb_array_length(p_phones), 0) > 0
        or coalesce(p_contact_page_url, '') <> ''
      ),
      contact_checked_at = now()
  where id = p_lead_id;

  return v_contact_id;
end;
$$;

grant execute on function public.upsert_contact_for_lead(bigint, jsonb, jsonb, text, text, jsonb) to service_role;
revoke execute on function public.upsert_contact_for_lead(bigint, jsonb, jsonb, text, text, jsonb) from anon, authenticated;
