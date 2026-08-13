-- ============================================================
-- Infrastructure / reference hosts carry no affiliate identity either.
--
-- Batch 2974 (Bing, "nettcasino…") returned google.com and its subdomains
-- (drive/accounts/calendar/sheets.corp.google.com) as "organic results".
-- google.com then matched a bad Monday affiliate row (an affiliates item whose
-- website was mistakenly google.com) → is_on_monday, and the affiliate-coupling
-- trigger flagged them as affiliates. Operators: "sites are not relevant and it
-- says they are affiliates / that we are listed."
--
-- is_social_host() already blanks social/shared hosts from the Monday matcher;
-- this extends it to search / cloud / reference infrastructure hosts, which are
-- never leads and never affiliates. Then a one-time backfill clears the false
-- flags that already landed (measured: ~480 on_monday, ~280 is_affiliate),
-- respecting operator overrides.
-- ============================================================

create or replace function public.is_social_host(p_registered text)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(lower(p_registered), '') in (
    -- social / shared platforms (identity is the handle, not the domain)
    'instagram.com','youtube.com','youtu.be','twitter.com','x.com','tiktok.com',
    'facebook.com','fb.com','m.facebook.com','t.me','telegram.me','telegram.org',
    'twitch.tv','kick.com','snapchat.com','linkedin.com','reddit.com',
    'pinterest.com','threads.net','vk.com','linktr.ee','discord.gg','discord.com',
    'medium.com','tumblr.com','quora.com','wa.me','whatsapp.com','spotify.com',
    'soundcloud.com','vimeo.com','dailymotion.com','rumble.com','onlyfans.com',
    'patreon.com','telegra.ph',
    -- search / cloud / reference infrastructure (never a lead or an affiliate)
    'google.com','gstatic.com','googleusercontent.com','goo.gl','bing.com',
    'microsoft.com','microsoftonline.com','live.com','msn.com','office.com',
    'windows.com','apple.com','icloud.com','amazon.com','amazonaws.com',
    'cloudfront.net','cloudflare.com','akamai.net','wikipedia.org','wikimedia.org',
    'archive.org','blogspot.com','wordpress.com','yahoo.com'
  );
$$;

grant execute on function public.is_social_host(text) to service_role, anon, authenticated;

-- ---- Backfill: clear the false flags these hosts already picked up ----

-- Monday flags (the matcher will no longer match them going forward).
update public.google_lead_gen_table g
set is_on_monday   = false,
    monday_board   = null,
    monday_item_id = null,
    monday_match_kind = null
where g.is_on_monday = true
  and g.monday_overridden_at is null
  and public.is_social_host(public.registered_domain(public.normalize_domain(coalesce(g.domain, g.url))));

-- Affiliate flags (a non-lead host is never an affiliate). Setting monday_board
-- to null above already makes the affiliate-coupling trigger a no-op here.
update public.google_lead_gen_table g
set is_affiliate         = false,
    affiliate_source     = 'system',
    affiliate_confidence = 'SKIPPED_NON_LEAD_HOST'
where g.is_affiliate = true
  and g.is_affiliate_overridden_at is null
  and public.is_social_host(public.registered_domain(public.normalize_domain(coalesce(g.domain, g.url))));
