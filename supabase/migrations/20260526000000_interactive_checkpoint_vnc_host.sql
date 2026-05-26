-- ============================================================
-- Per-checkpoint VNC host so the dashboard can route Open-VNC
-- clicks to the right VM in a multi-VM fleet.
--
-- Before this migration: the dashboard built every signed VNC URL
-- against a single env var (NEXT_PUBLIC_VNC_BASE_URL), so all
-- checkpoints had to terminate on one VM's nginx. Fine with one
-- worker box, broken the moment we scale to two or three.
--
-- After this migration: each VM passes its own public ingress host
-- (e.g. "https://54.79.22.202.nip.io") when it inserts a checkpoint
-- via the create_interactive_checkpoint RPC. The dashboard reads
-- that per-row and signs the URL against the matching VM. The env
-- var stays as a fallback for older rows or single-VM dev.
-- ============================================================

alter table public.interactive_checkpoints
  add column if not exists vnc_host text;

comment on column public.interactive_checkpoints.vnc_host is
  'Public base URL of the VM serving this checkpoint''s noVNC stream, '
  'e.g. https://54.79.22.202.nip.io. Written by the worker from its '
  'VM_PUBLIC_HOST env var. NULL falls back to NEXT_PUBLIC_VNC_BASE_URL '
  'on the dashboard side.';

-- ------------------------------------------------------------
-- Extend create_interactive_checkpoint to accept p_vnc_host.
-- Default NULL keeps the single-VM dev case working; production
-- VMs pass their own host so each card routes correctly.
-- ------------------------------------------------------------
drop function if exists public.create_interactive_checkpoint(
  uuid, text, integer, text, text, text, text, integer
);

create or replace function public.create_interactive_checkpoint(
  p_job_id          uuid,
  p_worker_id       text,
  p_worker_port     integer,
  p_reason          text,
  p_current_url     text default null,
  p_page_title      text default null,
  p_screenshot_path text default null,
  p_ttl_minutes     integer default 15,
  p_vnc_host        text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.interactive_checkpoints
    (job_id, worker_id, worker_port, reason, current_url, page_title,
     screenshot_path, expires_at, vnc_host)
  values
    (p_job_id, p_worker_id, p_worker_port, p_reason, p_current_url, p_page_title,
     p_screenshot_path, now() + make_interval(mins => p_ttl_minutes), p_vnc_host)
  returning id into v_id;

  update public.scrape_queue
  set status = 'needs_human',
      updated_at = now()
  where id = p_job_id;

  return v_id;
end;
$$;

grant execute on function public.create_interactive_checkpoint(
  uuid, text, integer, text, text, text, text, integer, text
) to service_role;
revoke execute on function public.create_interactive_checkpoint(
  uuid, text, integer, text, text, text, text, integer, text
) from anon, authenticated;
