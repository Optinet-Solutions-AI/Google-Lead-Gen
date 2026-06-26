-- ============================================================
-- Lock down SECURITY DEFINER / helper functions still callable by
-- everyone via the Postgres default PUBLIC EXECUTE grant (audit
-- Medium/Low + one extra instance found alongside them).
--
-- Same gotcha as 20260626130000: an explicit "grant to service_role"
-- (and even an explicit "revoke from anon, authenticated") does NOT
-- lock a function down, because Postgres auto-grants EXECUTE to PUBLIC
-- on creation and PUBLIC covers every role. Must revoke from PUBLIC.
--
-- All three are only invoked server-side via the service-role client:
--   - toggle_scheduled_item: behind assertAdmin() in the schedules
--     server action; the bare PUBLIC grant let any PostgREST caller
--     toggle any scheduled item, bypassing the admin gate. (Medium)
--   - search_website_on_monday: SECURITY DEFINER; author already
--     revoked anon/authenticated but missed PUBLIC, so it stayed open.
--   - brand_stem: IMMUTABLE pure helper; harmless but inconsistent. (Low)
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- Medium: admin-gated schedule toggle
revoke execute on function public.toggle_scheduled_item(uuid) from public;
grant  execute on function public.toggle_scheduled_item(uuid) to service_role;

-- Found alongside: SECURITY DEFINER Monday matcher (intended locked)
revoke execute on function public.search_website_on_monday(text) from public;
grant  execute on function public.search_website_on_monday(text) to service_role;

-- Low: pure immutable helper — lock to service_role for consistency
revoke execute on function public.brand_stem(text) from public, anon, authenticated;
grant  execute on function public.brand_stem(text) to service_role;
