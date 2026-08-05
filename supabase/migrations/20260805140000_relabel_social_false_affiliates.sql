-- ============================================================
-- One-time correction: clear the FALSE Monday classifications that the
-- bare-social-host bug produced, now that 20260805130000 stops the matcher
-- from firing on shared social hosts.
--
-- Before this, 1,335 Google/Bing leads whose only "match" was a bare social
-- host (youtube.com, reddit.com, facebook.com, instagram.com, x.com, …) were
-- labeled is_affiliate + is_rooster_partner (affiliate_source/rooster_source
-- = 'monday') and carried ~4,751 monday-origin brand s-tags — e.g. a random
-- YouTube video tagged with a Rooster casino brand. This undoes exactly those
-- monday-sourced effects for social-host leads.
--
-- Scope guards (only touch what the bug created):
--   * only leads whose registered host is_social_host()  → the bug's set
--   * monday_overridden_at IS NULL                         → respect manual overrides
--   * is_affiliate cleared only where affiliate_source='monday'
--   * is_rooster_partner cleared only where rooster_source='monday'
--       AND is_rooster_overridden_at IS NULL
--   * only s_tags with origin='monday' are deleted
-- Human/scrape-sourced classifications and s-tags are left untouched.
-- Contacts are intentionally NOT deleted here (see follow-up note).
-- Idempotent: after it runs, the predicate set is empty, so re-running is a
-- no-op.
-- ============================================================

-- 1) delete monday-origin s-tags on the affected leads FIRST (the predicate
--    keys off is_on_monday, which step 2 clears).
delete from public.s_tags_table st
using public.google_lead_gen_table g
where st.lead_id = g.id
  and st.origin = 'monday'
  and g.is_on_monday = true
  and g.monday_overridden_at is null
  and public.is_social_host(public.registered_domain(public.normalize_domain(coalesce(g.domain, g.url))));

-- 2) clear the match + monday-sourced classification on the affected leads.
update public.google_lead_gen_table g set
  is_on_monday        = false,
  monday_board        = null,
  monday_item_id      = null,
  monday_match_kind   = null,
  monday_inherited_at = null,
  is_affiliate        = case when g.affiliate_source = 'monday' then null else g.is_affiliate end,
  affiliate_source    = case when g.affiliate_source = 'monday' then null else g.affiliate_source end,
  is_rooster_partner  = case when g.rooster_source = 'monday' and g.is_rooster_overridden_at is null then false else g.is_rooster_partner end,
  rooster_source      = case when g.rooster_source = 'monday' and g.is_rooster_overridden_at is null then null else g.rooster_source end,
  has_s_tags          = exists (select 1 from public.s_tags_table s where s.lead_id = g.id)
where g.is_on_monday = true
  and g.monday_overridden_at is null
  and public.is_social_host(public.registered_domain(public.normalize_domain(coalesce(g.domain, g.url))));
