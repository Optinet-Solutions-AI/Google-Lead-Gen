-- ============================================================
-- One-off backfill: rewrite the old technical wording
-- "HITL timed out without operator action" on pre-existing
-- scrape_queue rows to match the friendly text that new HITL
-- failures already get from vm/worker.py (commit cd17196) and
-- the mark_scrape_job_captcha_terminal RPC default
-- (migrations 20260522020000 + 20260522030000).
--
-- Earlier wording passes intentionally left pre-existing rows
-- alone. This migration is the explicit catch-up: ops saw the
-- old text still on the Recent Activity table for rows created
-- before today's deploy and asked for the historical rows to be
-- rewritten too so the UI is consistent.
--
-- Idempotent — the WHERE clause matches only rows that still
-- carry the literal old string, so re-running is a no-op.
-- ============================================================

update public.scrape_queue
set    error_message = 'Couldn''t continue — a captcha appeared and nobody was around to solve it. Click ''Re-queue with Captcha helper'' on the Interactive page to try again.'
where  error_message = 'HITL timed out without operator action';
