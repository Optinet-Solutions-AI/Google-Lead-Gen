-- "Database error deleting user" — make the admin delete button work.
--
-- Deleting a user from /admin/users failed for anyone who had ever cleared an
-- interactive captcha. interactive_checkpoints.claimed_by_user_id references
-- auth.users with NO ACTION, so Postgres refused the delete and the UI showed
-- the driver's error with nothing an admin could do about it.
--
-- Who cleared a captcha months ago is useful history, not a reason to keep an
-- account alive. SET NULL keeps the checkpoint row — the job it belongs to,
-- when it was claimed, how it resolved — and drops only the person. The
-- resolution_method column still records whether a human or 2Captcha solved
-- it, which is what the reporting actually reads.
--
-- qa_feedback.user_id was already SET NULL; google_login_credentials.created_by
-- and system_settings.updated_by stay NO ACTION deliberately. Those are
-- credential and configuration provenance: if a delete is ever blocked by one,
-- that is worth an admin's attention rather than a silent detachment.

alter table public.interactive_checkpoints
  drop constraint if exists interactive_checkpoints_claimed_by_user_id_fkey;

alter table public.interactive_checkpoints
  add constraint interactive_checkpoints_claimed_by_user_id_fkey
  foreign key (claimed_by_user_id)
  references auth.users (id)
  on delete set null;
