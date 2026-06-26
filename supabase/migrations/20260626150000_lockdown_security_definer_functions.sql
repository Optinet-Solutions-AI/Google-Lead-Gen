-- ============================================================
-- CRITICAL: lock down every SECURITY DEFINER function in `public`.
--
-- This project has a default privilege that auto-grants EXECUTE to
-- anon + authenticated on every new function, and Postgres also grants
-- EXECUTE to PUBLIC by default. Most of our SECURITY DEFINER functions do
-- NOT self-check the caller — they rely on the app's server-action admin
-- gate. Combined, an UNAUTHENTICATED caller holding the public anon key can
-- invoke destructive RPCs directly via PostgREST (/rest/v1/rpc/<fn>) — e.g.
-- delete_leads_cascade, delete_scrape_job_cascade, set_system_setting,
-- force_logout_non_admins. (Discovered while sweeping the audit grant
-- findings; confirmed these four have no internal is_admin/auth.uid check.)
--
-- Fix: revoke EXECUTE from public/anon/authenticated on every SECURITY
-- DEFINER function in public and (re)grant only service_role. Verified the
-- app invokes all of them via the service-role client, so this is safe.
--
-- EXCEPTIONS (must stay reachable beyond service_role):
--   - is_admin: used inside RLS policies — `using (is_admin(auth.uid()))`
--     on google_login_credentials / system_settings / proxy_bandwidth —
--     which are evaluated as the querying role. Left UNTOUCHED so RLS keeps
--     working. (Harmless: read-only boolean, no data/mutation.)
--   - admin_reveal_google_login_credential: invoked on a user-session
--     (authenticated) client by the admin reveal action (admin-gated +
--     audit-logged). Keep authenticated; drop public/anon.
--
-- Also stops the bleed: future functions created by this role are no longer
-- auto-granted to public/anon/authenticated.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- 1. Stop future auto-exposure (applies to functions created by this role).
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- 2. Lock down existing SECURITY DEFINER functions (signature-safe loop).
do $$
declare
  r record;
begin
  for r in
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef            -- SECURITY DEFINER only
  loop
    if r.proname = 'is_admin' then
      -- Used in RLS policies; leave its grants untouched.
      continue;
    elsif r.proname = 'admin_reveal_google_login_credential' then
      execute format('revoke execute on function public.%I(%s) from public, anon', r.proname, r.args);
      execute format('grant execute on function public.%I(%s) to service_role, authenticated', r.proname, r.args);
    else
      execute format('revoke execute on function public.%I(%s) from public, anon, authenticated', r.proname, r.args);
      execute format('grant execute on function public.%I(%s) to service_role', r.proname, r.args);
    end if;
  end loop;
end $$;
