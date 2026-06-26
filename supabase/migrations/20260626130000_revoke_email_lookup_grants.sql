-- ============================================================
-- Lock down lookup_user_email_by_username (audit High finding).
--
-- 20260429140000_username_attribution.sql granted EXECUTE on this
-- SECURITY DEFINER function to service_role, authenticated AND anon.
-- It joins auth.users and returns the underlying email for a given
-- username, so the anon/authenticated grants let ANY caller (including
-- unauthenticated, via PostgREST /rest/v1/rpc) enumerate operator
-- emails from guessed usernames — PII + a social-engineering vector.
--
-- No app/lib/script code calls this RPC from the browser; it's only
-- needed server-side (service_role). Revoke the public-facing grants.
-- Idempotent — safe to run more than once.
-- ============================================================

revoke execute on function public.lookup_user_email_by_username(text) from anon, authenticated;
grant  execute on function public.lookup_user_email_by_username(text) to service_role;
