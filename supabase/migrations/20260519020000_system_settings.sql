-- ============================================================
-- system_settings — runtime-toggleable feature flags.
--
-- Operators need to flip behaviour like "human-in-the-loop captcha
-- resolver enabled" without SSH'ing into the worker VM and editing
-- .env. This generic key/value table backs an /admin/system page;
-- workers query the relevant key when they need it (per job, not
-- per poll — cheap).
--
-- First key:
--   hitl_enabled — when false, captcha / age-gate / cookie-banner
--                  walls fail the job (status='captcha') instead of
--                  parking it in 'needs_human' for an admin to
--                  resolve via noVNC. Useful when the noVNC viewer
--                  isn't wired up yet, or when an EU-market batch
--                  keeps tripping HITL faster than humans can clear.
-- ============================================================

create table if not exists public.system_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table public.system_settings enable row level security;

-- Reads: admin-only. Workers go through the service-role RPC below
-- so they don't need a direct RLS bypass policy here.
drop policy if exists "system_settings_admin_read" on public.system_settings;
create policy "system_settings_admin_read"
  on public.system_settings for select
  to authenticated
  using (public.is_admin(auth.uid()));

-- Seed the HITL flag default-on so existing behaviour is preserved
-- until an admin explicitly turns it off.
insert into public.system_settings (key, value)
values ('hitl_enabled', 'true'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- RPC: get_system_setting — service-role + admin.
-- Returns jsonb (null if key missing). Workers call this on each
-- process_job to honour the current flag without restart.
-- ------------------------------------------------------------
create or replace function public.get_system_setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select value from public.system_settings where key = p_key;
$$;

revoke execute on function public.get_system_setting(text) from public, anon;
grant execute on function public.get_system_setting(text) to authenticated, service_role;

-- ------------------------------------------------------------
-- RPC: set_system_setting — admin-only.
-- Upserts the value and stamps updated_by from auth.uid().
-- ------------------------------------------------------------
create or replace function public.set_system_setting(
  p_key   text,
  p_value jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
begin
  -- service_role calls bypass auth.uid(); admin-only otherwise.
  if v_user_id is not null then
    select coalesce(public.is_admin(v_user_id), false) into v_is_admin;
    if not v_is_admin then
      raise exception 'forbidden: admin only' using errcode = '42501';
    end if;
  end if;

  if length(coalesce(trim(p_key), '')) = 0 then
    raise exception 'key required' using errcode = '22023';
  end if;
  if p_value is null then
    raise exception 'value required' using errcode = '22023';
  end if;

  insert into public.system_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), v_user_id)
  on conflict (key)
  do update set value      = excluded.value,
                updated_at = now(),
                updated_by = excluded.updated_by;

  return p_value;
end;
$$;

revoke execute on function public.set_system_setting(text, jsonb) from public, anon;
grant execute on function public.set_system_setting(text, jsonb) to authenticated, service_role;
