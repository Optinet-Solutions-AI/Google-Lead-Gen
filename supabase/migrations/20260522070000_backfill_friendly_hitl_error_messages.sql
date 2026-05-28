-- ============================================================
-- One-off backfill: rewrite the old technical wording
-- "HITL timed out without operator action" on pre-existing
-- scrape_queue rows to match the friendly text that new Captcha
-- solver failures already get from vm/worker.py (commit cd17196)
-- and the mark_scrape_job_captcha_terminal RPC default
-- (migrations 20260522020000 + 20260522030000). The WHERE clause
-- below intentionally pins on the legacy "HITL timed out" string
-- because that's what was actually written to those rows at the
-- time — don't sanitize this literal during the 2026-05-28 rename
-- pass or this backfill stops matching.
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
