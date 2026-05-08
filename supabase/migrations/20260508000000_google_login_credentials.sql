-- Per-country Google account credentials for the scraper to auto-login when
-- the GoLogin profile gets logged out by IP rotation. Passwords go through
-- Supabase Vault (pgsodium-backed); the table stores only the secret_id.
--
-- Access model:
--   • Admins manage via /admin/google-login (server actions → SECURITY DEFINER RPCs).
--     Admins can list / deactivate / replace, but never read passwords.
--   • The scraper (service_role) calls get_google_login_credential() to
--     fetch the decrypted email + password right before driving the login flow.
--   • Direct table access is locked down by RLS to admins only, and only
--     ever exposes metadata (no password column lives on the table).

create table if not exists public.google_login_credentials (
  id uuid primary key default gen_random_uuid(),
  country_code text not null references public.gologin_profiles(country_code) on delete cascade,
  email text not null,
  password_secret_id uuid not null,
  is_active boolean not null default true,
  last_used_at timestamptz,
  last_used_status text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- One ACTIVE credential per country. We keep deactivated rows around for
-- audit, so the partial unique index targets the active subset only.
create unique index if not exists idx_google_login_creds_active_country
  on public.google_login_credentials (country_code)
  where is_active;

create index if not exists idx_google_login_creds_country
  on public.google_login_credentials (country_code);

-- RLS: lock down direct table access. Reads are admin-only and limited to
-- metadata (the password lives in vault.secrets, not on this table).
alter table public.google_login_credentials enable row level security;

drop policy if exists "google_login_creds_admin_read" on public.google_login_credentials;
create policy "google_login_creds_admin_read"
  on public.google_login_credentials for select
  to authenticated
  using (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- RPC: set_google_login_credential
-- Admin-callable. Encrypts password into vault, deactivates any existing
-- active row for the country, and inserts a fresh active row pointing at the
-- new vault secret.
-- ---------------------------------------------------------------------------
create or replace function public.set_google_login_credential(
  p_country_code text,
  p_email text,
  p_password text,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_secret_id uuid;
  v_existing_id uuid;
  v_existing_secret_id uuid;
begin
  -- service_role calls bypass auth.uid(). Admin-only otherwise.
  if v_user_id is not null then
    select coalesce(public.is_admin(v_user_id), false) into v_is_admin;
    if not v_is_admin then
      raise exception 'forbidden: admin only' using errcode = '42501';
    end if;
  end if;

  if length(coalesce(trim(p_email), '')) = 0 then
    raise exception 'email required' using errcode = '22023';
  end if;
  if length(coalesce(p_password, '')) = 0 then
    raise exception 'password required' using errcode = '22023';
  end if;

  -- vault.create_secret returns the new secret's UUID. Name is just a
  -- human-readable tag in the vault UI; we keep it unique with the country
  -- code + a random suffix so multiple writes for the same country don't
  -- collide on the unique-name constraint.
  v_secret_id := vault.create_secret(
    p_password,
    'google_login_' || p_country_code || '_' || replace(gen_random_uuid()::text, '-', '')
  );

  select id, password_secret_id
    into v_existing_id, v_existing_secret_id
  from public.google_login_credentials
  where country_code = p_country_code and is_active = true
  limit 1;

  if v_existing_id is null then
    insert into public.google_login_credentials
      (country_code, email, password_secret_id, notes, created_by)
    values
      (p_country_code, p_email, v_secret_id, p_notes, v_user_id)
    returning id into v_existing_id;
  else
    -- Replace in-place: same row stays active, just points at the new secret.
    update public.google_login_credentials
       set email = p_email,
           password_secret_id = v_secret_id,
           notes = coalesce(p_notes, notes),
           updated_at = now(),
           last_used_at = null,
           last_used_status = null
     where id = v_existing_id;

    -- Best-effort cleanup of the previous vault secret. If this fails
    -- (permissions, race), the new secret is already in place; orphaned
    -- vault rows are harmless.
    begin
      delete from vault.secrets where id = v_existing_secret_id;
    exception when others then
      -- swallow
      null;
    end;
  end if;

  return v_existing_id;
end;
$$;

revoke execute on function public.set_google_login_credential(text, text, text, text) from public, anon;
grant execute on function public.set_google_login_credential(text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RPC: deactivate_google_login_credential
-- Admin-callable. Marks the active row inactive and drops the vault secret.
-- ---------------------------------------------------------------------------
create or replace function public.deactivate_google_login_credential(p_country_code text)
returns boolean
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_id uuid;
  v_secret_id uuid;
begin
  if v_user_id is not null then
    select coalesce(public.is_admin(v_user_id), false) into v_is_admin;
    if not v_is_admin then
      raise exception 'forbidden: admin only' using errcode = '42501';
    end if;
  end if;

  select id, password_secret_id
    into v_id, v_secret_id
  from public.google_login_credentials
  where country_code = p_country_code and is_active = true
  limit 1;

  if v_id is null then return false; end if;

  update public.google_login_credentials
     set is_active = false, updated_at = now()
   where id = v_id;

  begin
    delete from vault.secrets where id = v_secret_id;
  exception when others then
    null;
  end;
  return true;
end;
$$;

revoke execute on function public.deactivate_google_login_credential(text) from public, anon;
grant execute on function public.deactivate_google_login_credential(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RPC: get_google_login_credential
-- Service-role only. Returns the decrypted email + password for the active
-- credential of a country. Called by the scraper via PostgREST.
-- ---------------------------------------------------------------------------
create or replace function public.get_google_login_credential(p_country_code text)
returns table(email text, password text)
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  return query
  select c.email,
         ds.decrypted_secret::text as password
    from public.google_login_credentials c
    join vault.decrypted_secrets ds on ds.id = c.password_secret_id
   where c.country_code = p_country_code
     and c.is_active = true
   limit 1;
end;
$$;

revoke execute on function public.get_google_login_credential(text) from public, anon, authenticated;
grant execute on function public.get_google_login_credential(text) to service_role;

-- ---------------------------------------------------------------------------
-- RPC: mark_google_login_used
-- Service-role only. Stamps the active credential after each scraper attempt
-- so admins can see when a credential last worked / failed.
-- ---------------------------------------------------------------------------
create or replace function public.mark_google_login_used(
  p_country_code text,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.google_login_credentials
     set last_used_at = now(),
         last_used_status = p_status,
         updated_at = now()
   where country_code = p_country_code and is_active = true;
end;
$$;

revoke execute on function public.mark_google_login_used(text, text) from public, anon, authenticated;
grant execute on function public.mark_google_login_used(text, text) to service_role;
