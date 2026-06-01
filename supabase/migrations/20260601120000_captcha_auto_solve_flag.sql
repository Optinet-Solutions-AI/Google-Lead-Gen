-- ============================================================
-- captcha_auto_solve — runtime flag for the automated 2Captcha solver.
--
-- Distinct from `captcha_solver_enabled` (the legacy SQL identifier
-- `hitl_enabled`), which gates the MANUAL noVNC operator flow. This new
-- flag gates the AUTOMATED 2Captcha service:
--   * When TRUE  — on a captcha wall (Google /sorry/ reCAPTCHA or Bing
--                  Cloudflare Turnstile) the worker submits the challenge
--                  to 2Captcha, injects the returned token, and resumes.
--                  On a failed solve it falls through to whatever the
--                  manual flag dictates, ultimately [RESULT] CAPTCHA →
--                  worker auto-retry with a fresh proxy/fingerprint.
--   * When FALSE — the worker never calls 2Captcha. Existing behaviour
--                  (manual noVNC checkpoint, or fail-fast) is unchanged.
--
-- Seeded FALSE on purpose: 2Captcha charges per solve, and the
-- TWOCAPTCHA_API_KEY must be present in each VM's ~/.env before this is
-- safe to enable. Flip it ON from /admin/system once all three VMs have
-- the key deployed.
--
-- The worker reads this live via get_system_setting('captcha_auto_solve')
-- at the moment it hits a wall — no restart needed to take effect.
-- ============================================================

insert into public.system_settings (key, value)
values ('captcha_auto_solve', 'false'::jsonb)
on conflict (key) do nothing;
