-- ============================================================
-- Migration: Track Google-login state per GoLogin profile
--
-- Some countries (Germany, France, Italy, etc.) gate gambling /
-- adult-content results behind an age-verified Google account.
-- Scraping those countries without being signed in returns very
-- few PPC ads and sometimes triggers consent walls.
--
-- Adds:
--   requires_google_login      — does this country need login at all?
--   is_google_logged_in        — is the GoLogin profile currently signed in?
--   google_login_verified_at   — when we last confirmed the login is healthy
--   google_login_notes         — free-text (e.g. "Used acct: foo@gmail.com")
--
-- The enqueue form will show a warning when a user picks a country
-- whose profile requires login but isn't currently logged in.
-- ============================================================

alter table public.gologin_profiles
  add column if not exists requires_google_login    boolean     not null default false,
  add column if not exists is_google_logged_in      boolean     not null default false,
  add column if not exists google_login_verified_at timestamptz,
  add column if not exists google_login_notes       text;

-- Best-guess seed: countries with strict adult-content rules that
-- typically require a logged-in age-verified Google account for
-- gambling-keyword PPC ads to render. Adjust by hand if wrong.
update public.gologin_profiles
   set requires_google_login = true
 where country_code in ('DE', 'IT', 'AT', 'NO', 'DK', 'GB');
