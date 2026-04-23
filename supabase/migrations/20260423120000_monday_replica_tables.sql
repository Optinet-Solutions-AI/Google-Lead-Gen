-- ============================================================
-- Migration: Monday.com Replica Tables
--
-- Creates 8 tables mirroring 4 Monday boards + their updates:
--
--   leads_table                          + leads_updates_table
--   affiliates_table                     + affiliates_updates_table
--   not_relevant_leads_table             + not_relevant_leads_updates_table
--   email_undelivered_leads_table        + email_undelivered_leads_updates_table
--
-- Column names match Monday column titles (snake_cased).
-- Every column is `text` regardless of Monday type (status, numbers,
-- date, email, people, long_text) so the sync script can store the
-- display string from Monday's `column_values.text` field directly.
-- The full raw shape is preserved in raw_column_values (jsonb).
--
-- All tables are append-or-upsert on the `monday_item_id` / `monday_update_id`
-- unique index — the sync script is safe to re-run.
--
-- Board IDs discovered on 2026-04-23:
--   Leads                    1236073873
--   Affiliates               1237788929
--   Not Relevant Leads       1237789472
--   Email Undelivered Leads  1237006289
-- ============================================================

-- ------------------------------------------------------------
-- leads_table (Leads board — 13 columns)
-- ------------------------------------------------------------
create table if not exists public.leads_table (
  id                bigint      generated always as identity primary key,
  monday_item_id    text        not null unique,
  name              text,
  group_title       text,
  keywords          text,
  status            text,
  comments          text,
  email             text,
  traffic_size      text,
  source            text,
  files             text,
  owner             text,
  geo               text,
  date              text,
  website           text,
  subitems_count    integer,
  raw_column_values jsonb,
  monday_created_at timestamptz,
  monday_updated_at timestamptz,
  synced_at         timestamptz not null default now()
);

create table if not exists public.leads_updates_table (
  id                bigint      generated always as identity primary key,
  monday_update_id  text        not null unique,
  monday_item_id    text        not null,
  body_html         text,
  body_text         text,
  creator_id        text,
  creator_name      text,
  creator_email     text,
  monday_created_at timestamptz,
  synced_at         timestamptz not null default now()
);
create index if not exists idx_leads_updates_item_id
  on public.leads_updates_table (monday_item_id);

-- ------------------------------------------------------------
-- affiliates_table (Affiliates board — 18 columns)
-- ------------------------------------------------------------
create table if not exists public.affiliates_table (
  id                bigint      generated always as identity primary key,
  monday_item_id    text        not null unique,
  name              text,
  group_title       text,
  keywords          text,
  l7_sj_rs_lv_ro    text,
  rb_fp_su          text,
  pm                text,
  nd                text,
  affiliate_name    text,
  status            text,
  comments          text,
  email             text,
  traffic_size      text,
  source            text,
  files             text,
  geo               text,
  owner             text,
  date              text,
  website           text,
  subitems_count    integer,
  raw_column_values jsonb,
  monday_created_at timestamptz,
  monday_updated_at timestamptz,
  synced_at         timestamptz not null default now()
);

create table if not exists public.affiliates_updates_table (
  id                bigint      generated always as identity primary key,
  monday_update_id  text        not null unique,
  monday_item_id    text        not null,
  body_html         text,
  body_text         text,
  creator_id        text,
  creator_name      text,
  creator_email     text,
  monday_created_at timestamptz,
  synced_at         timestamptz not null default now()
);
create index if not exists idx_affiliates_updates_item_id
  on public.affiliates_updates_table (monday_item_id);

-- ------------------------------------------------------------
-- not_relevant_leads_table (Not Relevant Leads board — 16 columns)
-- ------------------------------------------------------------
create table if not exists public.not_relevant_leads_table (
  id                bigint      generated always as identity primary key,
  monday_item_id    text        not null unique,
  name              text,
  group_title       text,
  keywords          text,
  affiliate_id      text,
  affiliate_name    text,
  status            text,
  comments          text,
  google_page       text,
  email             text,
  traffic_size      text,
  source            text,
  files             text,
  geo               text,
  owner             text,
  date              text,
  website           text,
  subitems_count    integer,
  raw_column_values jsonb,
  monday_created_at timestamptz,
  monday_updated_at timestamptz,
  synced_at         timestamptz not null default now()
);

create table if not exists public.not_relevant_leads_updates_table (
  id                bigint      generated always as identity primary key,
  monday_update_id  text        not null unique,
  monday_item_id    text        not null,
  body_html         text,
  body_text         text,
  creator_id        text,
  creator_name      text,
  creator_email     text,
  monday_created_at timestamptz,
  synced_at         timestamptz not null default now()
);
create index if not exists idx_not_relevant_leads_updates_item_id
  on public.not_relevant_leads_updates_table (monday_item_id);

-- ------------------------------------------------------------
-- email_undelivered_leads_table (Email Undelivered Leads — 16 columns)
-- ------------------------------------------------------------
create table if not exists public.email_undelivered_leads_table (
  id                bigint      generated always as identity primary key,
  monday_item_id    text        not null unique,
  name              text,
  group_title       text,
  keywords          text,
  affiliate_id      text,
  affiliate_name    text,
  status            text,
  comments          text,
  google_page       text,
  email             text,
  traffic_size      text,
  source            text,
  files             text,
  geo               text,
  owner             text,
  date              text,
  website           text,
  subitems_count    integer,
  raw_column_values jsonb,
  monday_created_at timestamptz,
  monday_updated_at timestamptz,
  synced_at         timestamptz not null default now()
);

create table if not exists public.email_undelivered_leads_updates_table (
  id                bigint      generated always as identity primary key,
  monday_update_id  text        not null unique,
  monday_item_id    text        not null,
  body_html         text,
  body_text         text,
  creator_id        text,
  creator_name      text,
  creator_email     text,
  monday_created_at timestamptz,
  synced_at         timestamptz not null default now()
);
create index if not exists idx_email_undelivered_leads_updates_item_id
  on public.email_undelivered_leads_updates_table (monday_item_id);
