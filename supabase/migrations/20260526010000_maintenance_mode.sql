-- ============================================================
-- Maintenance mode — block non-admin access during deploys.
--
-- When 'maintenance_mode' is true:
--   1. Non-admin users hitting any /(dashboard) route are
--      redirected to /maintenance with the operator's notice.
--   2. Non-admin sign-in attempts are rejected with the same
--      notice.
--   3. Admins keep full access so they can keep working.
--
-- The toggle on /admin/system also fires force_logout_non_admins
-- on enable so anyone currently signed in gets booted immediately
-- (not just blocked on their next request).
-- ============================================================

insert into public.system_settings (key, value)
values ('maintenance_mode', 'false'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- RPC: force_logout_non_admins
-- Deletes every auth session NOT owned by an admin. Admins
-- (currently signed in) keep their cookies; everyone else loses
-- access on their next request.
--
-- Returns the number of sessions deleted so the UI can show a
-- "kicked N users" confirmation.
-- ------------------------------------------------------------
create or replace function public.force_logout_non_admins()
returns integer
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_caller   uuid := auth.uid();
  v_is_admin boolean;
  v_count    integer := 0;
begin
  -- service_role bypasses auth.uid(); when called from a server action
  -- we still verify the caller is admin.
  if v_caller is not null then
    select coalesce(public.is_admin(v_caller), false) into v_is_admin;
    if not v_is_admin then
      raise exception 'forbidden: admin only' using errcode = '42501';
    end if;
  end if;

  -- Nuke every refresh token + session whose user is not an admin.
  -- auth.refresh_tokens.user_id is text-cast of uuid; cast for the join.
  with kept as (
    select id from auth.users where public.is_admin(id)
  )
  delete from auth.sessions s
   where s.user_id not in (select id from kept);
  get diagnostics v_count = row_count;

  delete from auth.refresh_tokens r
   where r.user_id not in (select id::text from auth.users where public.is_admin(id));

  return v_count;
end;
$$;

revoke execute on function public.force_logout_non_admins() from public, anon;
grant  execute on function public.force_logout_non_admins() to service_role;
