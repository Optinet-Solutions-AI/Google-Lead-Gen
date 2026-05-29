-- ============================================================
-- Open Google-login password reveal to any signed-in operator,
-- not just admins.
--
-- Rationale: the QA / ops team (Supriya, Darren, Andrei, Gemma,
-- Ryan, Jana) needs to look up Google account passwords to drive
-- the Captcha-solver flow when the scraper trips a Google
-- "verify-it's-you" / 2FA prompt. Requiring an admin to relay
-- the password every time is operational friction; the accounts
-- are throwaway per-country scraping logins anyway (see the
-- warning banner on /admin/google-login), so the blast radius
-- of broadening read access is small.
--
-- What this changes:
--   * admin_reveal_google_login_credential — drop the is_admin()
--     check, keep the signed-in check. Renamed function-comment
--     to reflect new semantics; function name stays for
--     backwards-compat with existing callers.
--   * RLS on google_login_credentials — broaden SELECT from
--     admin-only to any authenticated user (metadata only; the
--     password column does not live on the table).
--
-- What stays locked down:
--   * set_google_login_credential — admin only (write).
--   * deactivate_google_login_credential — admin only (delete).
--   * get_google_login_credential — service_role only (scraper).
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
begin
  -- Signed-in check only — broadened from is_admin() so the whole
  -- ops team can self-serve. Every call still goes through the
  -- dashboard server action, which writes an activity_log row
  -- (action='google_login_credential.reveal') so we keep an audit
  -- trail of who saw which credential when.
  if v_user_id is null then
    raise exception 'not signed in' using errcode = '42501';
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

-- RLS: broaden the metadata SELECT from admin-only to authenticated.
-- The password column does not live on this table (it's in
-- vault.secrets via password_secret_id) so this only exposes
-- email/country/last_used_at/notes — same fields the page renders.
drop policy if exists "google_login_creds_admin_read" on public.google_login_credentials;
drop policy if exists "google_login_creds_authenticated_read" on public.google_login_credentials;
create policy "google_login_creds_authenticated_read"
  on public.google_login_credentials for select
  to authenticated
  using (true);
