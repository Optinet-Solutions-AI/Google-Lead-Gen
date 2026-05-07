-- ============================================================
-- Migration: QA-phase feedback (the floating message-icon widget)
--
-- Any signed-in user can submit feedback from the bottom-right
-- floating widget on every dashboard page. URLs are encouraged
-- (often pre-filled with the current page so the admin can
-- click-through-and-reproduce). Admins manage the queue at
-- /admin/feedback — change status, drill into the message,
-- delete when done.
-- ============================================================

create table if not exists public.qa_feedback (
  id            bigint generated always as identity primary key,
  user_id       uuid references auth.users(id) on delete set null,
  -- Denormalized at insert so feedback survives a user delete
  -- with the original author's name intact.
  user_display  text,
  user_email    text,
  url           text,
  message       text not null check (char_length(message) between 1 and 4000),
  status        text not null default 'open'
                check (status in ('open', 'in_progress', 'resolved', 'rejected')),
  resolved_at   timestamptz,
  resolved_by   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_qa_feedback_status_created_at
  on public.qa_feedback (status, created_at desc);
create index if not exists idx_qa_feedback_user_id
  on public.qa_feedback (user_id)
  where user_id is not null;

-- Touch updated_at on every row change so the admin UI can show
-- "last activity" without us hand-stamping it everywhere.
create or replace function public.touch_qa_feedback_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_qa_feedback_updated_at on public.qa_feedback;
create trigger trg_qa_feedback_updated_at
  before update on public.qa_feedback
  for each row execute function public.touch_qa_feedback_updated_at();
