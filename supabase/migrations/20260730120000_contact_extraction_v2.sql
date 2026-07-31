-- ============================================================
-- Contact Extraction v2 — per-item provenance + socials/address/forms.
--
-- Baseline audit (LGP-184) findings this addresses:
--   * attribution was tier-level only — no per-email/phone source URL,
--     method, or confidence. Adds `items` (the rich provenance array).
--   * 0 socials / 0 addresses / 0 contact-forms captured. Adds columns.
--   * has_contact_details over-reported. Recompute from real signal.
--
-- Back-compat: existing columns (emails/phones/contact_page_url/source/
-- raw) and upsert_contact_for_lead(...) are untouched. New columns are
-- nullable; a new upsert_contact_for_lead_v2(...) writes the rich shape.
-- ============================================================

alter table public.contact_table
  add column if not exists items         jsonb,   -- [{kind,value,method,sourceUrl,confidence,label}]
  add column if not exists socials       jsonb,   -- [{platform,url,sourceUrl}]
  add column if not exists address       text,
  add column if not exists contact_forms jsonb;   -- ["https://…/contact", …]

-- Source enum: add the granular methods the v2 extractor emits at the
-- table level (the per-item method lives in `items`). Keep all prior
-- values so old rows stay valid.
alter table public.contact_table
  drop constraint if exists contact_table_source_check;
alter table public.contact_table
  add constraint contact_table_source_check
  check (source in ('regex', 'multi_page', 'openai', 'claude', 'hunter', 'manual', 'json_ld', 'mixed'));

create or replace function public.upsert_contact_for_lead_v2(
  p_lead_id          bigint,
  p_emails           jsonb,
  p_phones           jsonb,
  p_contact_page_url text,
  p_source           text default 'regex',
  p_raw              jsonb default null,
  p_items            jsonb default null,
  p_socials          jsonb default null,
  p_address          text  default null,
  p_contact_forms    jsonb default null
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
  -- Replace previous AUTO rows only; manual edits survive.
  delete from public.contact_table
  where lead_id = p_lead_id
    and source <> 'manual';

  insert into public.contact_table
    (lead_id, emails, phones, contact_page_url, source, raw, items, socials, address, contact_forms)
  values
    (p_lead_id, p_emails, p_phones, p_contact_page_url, p_source, p_raw, p_items, p_socials, p_address, p_contact_forms)
  returning id into v_contact_id;

  -- has_contact_details now counts ANY reachable channel: email, phone,
  -- contact page/form, or a social link. (Fixes the audit's over-report
  -- where empty rows were still flagged true.)
  update public.google_lead_gen_table
  set contact_id = v_contact_id,
      has_contact_details = (
        coalesce(jsonb_array_length(p_emails), 0) > 0
        or coalesce(jsonb_array_length(p_phones), 0) > 0
        or coalesce(p_contact_page_url, '') <> ''
        or coalesce(jsonb_array_length(p_socials), 0) > 0
        or coalesce(jsonb_array_length(p_contact_forms), 0) > 0
      ),
      contact_checked_at = now()
  where id = p_lead_id;

  return v_contact_id;
end;
$$;

grant execute on function public.upsert_contact_for_lead_v2(bigint, jsonb, jsonb, text, text, jsonb, jsonb, jsonb, text, jsonb) to service_role;
revoke execute on function public.upsert_contact_for_lead_v2(bigint, jsonb, jsonb, text, text, jsonb, jsonb, jsonb, text, jsonb) from anon, authenticated;
