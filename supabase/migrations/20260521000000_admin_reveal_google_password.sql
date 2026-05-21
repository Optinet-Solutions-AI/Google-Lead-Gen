-- ============================================================
-- Admin-gated RPC to reveal a stored Google login password.
--
-- The original credentials flow (20260508000000_google_login_credentials)
-- was write-only by design — admins set a password but couldn't read it
-- back. In practice that's a worse UX than the marginal extra security
-- buys us: the /admin/google-login page is already admin-RLS-gated,
-- and admins routinely need to verify "did I type the right password?"
-- or look up the existing value to share with a teammate.
--
-- This RPC is the read-side companion to set_google_login_credential.
-- It returns email + decrypted password, gated by is_admin(). The
-- service-role-only get_google_login_credential RPC (used by the
-- scraper) is unchanged.
-- ============================================================

create or replace function public.admin_reveal_google_login_credential(
  p_country_code text
) returns table(email text, password text)
language plpgsql
stable
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
begin
  if v_user_id is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select coalesce(public.is_admin(v_user_id), false) into v_is_admin;
  if not v_is_admin then
    raise exception 'forbidden: admin only' using errcode = '42501';
  end if;

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

revoke execute on function public.admin_reveal_google_login_credential(text) from public, anon;
grant execute on function public.admin_reveal_google_login_credential(text) to authenticated;
