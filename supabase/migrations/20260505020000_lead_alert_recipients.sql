-- ============================================================
-- Migration: Lead-alert recipients
--
-- Foundation for the future "email an affiliate manager when a lead
-- meets our quality bar" feature. This migration adds ONLY the
-- recipient registry — the conditions for what counts as alert-worthy
-- and the email-sending plumbing land in a follow-up.
--
--   - lead_alert_recipients: who should be notified, and optionally
--     scope them to a single country (e.g. the German affiliate
--     manager only gets DE/AT/CH leads).
--   - lead_alerts_log: an audit-trail table for every alert that ever
--     gets sent (lead, recipient, sent_at, channel, message_id, error).
--     Empty until the email sender lands; tracking it here keeps the
--     audit chain consistent with activity_log.
--
-- Both are admin-only via service_role; no RLS policies for now.
-- ============================================================

create table if not exists public.lead_alert_recipients (
  id              bigint generated always as identity primary key,
  email           text        not null,
  name            text,
  -- Optional ISO country code — when set, this recipient only gets
  -- alerts for leads scraped from that country. NULL = receives every
  -- alert regardless of country.
  country_code    text,
  is_active       boolean     not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      text,
  updated_at      timestamptz not null default now()
);

-- Email is unique case-insensitively — same person can't be added twice.
create unique index if not exists idx_lead_alert_recipients_email_unique
  on public.lead_alert_recipients (lower(email));

-- Lookup index for the dispatcher: "who should be alerted on this lead?"
-- WHERE is_active = true AND (country_code IS NULL OR country_code = $1)
create index if not exists idx_lead_alert_recipients_active_country
  on public.lead_alert_recipients (country_code, is_active)
  where is_active = true;

-- ------------------------------------------------------------
-- Audit trail of every alert that gets sent. Stays empty until the
-- email sender lands in a follow-up — building the table now keeps
-- migrations atomic and avoids retrofitting later.
-- ------------------------------------------------------------
create table if not exists public.lead_alerts_log (
  id              bigint generated always as identity primary key,
  lead_id         bigint      not null references public.google_lead_gen_table(id) on delete cascade,
  recipient_email text        not null,
  recipient_name  text,
  channel         text        not null default 'email',
  -- Provider message id (Brevo's response). Null when send fails.
  message_id      text,
  sent_at         timestamptz not null default now(),
  -- Who triggered this alert: 'auto' for the future trigger or the
  -- display_name / email of the user who manually clicked Send.
  sent_by         text,
  -- Populated when the provider returned an error so the admin page
  -- can show a "last delivery failed" indicator per recipient.
  error           text
);

create index if not exists idx_lead_alerts_log_lead_id
  on public.lead_alerts_log (lead_id);
create index if not exists idx_lead_alerts_log_sent_at
  on public.lead_alerts_log (sent_at desc);

-- ------------------------------------------------------------
-- Touch updated_at on row changes so the admin UI can show staleness.
-- ------------------------------------------------------------
create or replace function public.touch_lead_alert_recipients_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_lead_alert_recipients_updated_at on public.lead_alert_recipients;
create trigger trg_lead_alert_recipients_updated_at
  before update on public.lead_alert_recipients
  for each row execute function public.touch_lead_alert_recipients_updated_at();
