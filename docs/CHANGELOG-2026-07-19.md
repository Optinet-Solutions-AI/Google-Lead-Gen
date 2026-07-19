# 2026-07-19 · Fleet resize + observability push

Bundled record of the changes shipped in this session.

## TL;DR

- **Fleet reduced 3 VMs → 2 VMs.** Code side already flipped
  (`FLEET_VM_COUNT = 2` in [`lib/fleet.ts`](../lib/fleet.ts)). AWS-side
  decommission of the third VM scheduled for 2026-07-20 pending Ivan's
  approval. Remaining two VMs to be resized 29 GB → 50 GB via online
  EBS expansion.
- **New dashboard: `/admin/utilization`.** Live fleet / queue / country
  / user-cap adherence. Auto-refresh 30 s.
- **New dashboard: `/stag-mapping`.** Same-operator detection via
  grouped S-tags, mirror-domain surfacing, Monday-mirror freshness
  banner, admin *Sync now* button.
- **Enqueue form** now carries live queue-depth UX (see
  [`dashboards.md`](./dashboards.md#scrape-enqueue-form-additions-2026-07-19)).
- **Cost line updated** — Enigma actual $100/mo (not $400 planned),
  Vercel + Supabase $10 each. New total ~$395/mo (~$0.07 per lead).

## Files touched

**New**
- `lib/fleet.ts` — single source of truth for fleet dimensions.
- `app/(dashboard)/admin/utilization/` — page, queries, auto-refresh client.
- `app/(dashboard)/stag-mapping/` — page, queries, sync-controls, interactive table.
- `docs/dashboards.md`, `docs/CHANGELOG-2026-07-19.md` (this file).
- `scripts/qa/_system-diagnostic.ts` — end-of-session health probe.

**Modified**
- `app/(dashboard)/_components/dashboard-shell.tsx` — nav entries for
  Utilization and S-tag Mapping.
- `app/(dashboard)/scrape/page.tsx` — loads `getFleetQueueSnapshot()`;
  passes to enqueue form and both jobs-table renderers.
- `app/(dashboard)/scrape/_lib/queries.ts` — new snapshot function
  computes per-job queue positions + ETAs in the same order the
  worker's `claim_scrape_job` RPC picks jobs.
- `app/(dashboard)/scrape/_components/enqueue-form.tsx` — FleetLoadPill,
  FleetLoadBanner, CountryQueueBadge, dropdown option hints, submit-button ETA.
- `app/(dashboard)/scrape/_components/jobs-table.tsx` — QueuePositionBadge
  on every pending row (desktop + mobile).
- `app/(dashboard)/scrape/actions.ts` — insert returns ids; toast peeks
  at the queue and reports "you're #N in the country queue · come back
  in ~X min".
- `docs/runbook-multi-vm.md` — header block noting current 2-VM state.

## Rationale (short version)

Jose flagged the 3 VMs hitting 96% disk. Investigating showed fleet
utilization is <1% of capacity even on peak days — the pressure is
system-file/cache growth, not workload growth. Two VMs is comfortably
enough (18 slots ≈ 311 jobs/hr theoretical throughput vs. observed
peak of 57 jobs/day), saves ~$75/mo on AWS EC2, and disk headroom is
solved by growing the EBS volumes on the remaining pair (~$3/mo cost).
Net savings: ~$72/mo.

The observability push is the safeguard: users now see live queue
depth, per-country capacity, position in queue, and estimated wait
time. Admins see fleet utilization, backlog, per-user cap adherence,
and can trigger a Monday resync on demand.

## System diagnostic snapshot (2026-07-19 14:28 UTC)

Run `npx tsx scripts/qa/_system-diagnostic.ts` to reproduce.

- Fleet workers: **0 locks held** (idle — no jobs running)
- Scrape queue: 0 jobs last 24h · **121 in `captcha` status
  (stuck, pre-existing)** · 1 in `needs_human`
- Enigma bandwidth poller: 3 min ago; **11.63 GB used / 3.37 GB
  remaining of 15 GB plan** · `is_low` false
- Monday mirror freshness (all OK, nightly cron working):
  - Leads · 4,589 items · 928 min ago
  - Affiliates · 7,268 items · 918 min ago
  - Not Relevant · 1,987 items · 908 min ago
  - Email Undelivered · 289 items · 897 min ago
- S-tag mapping: **566 tag rows total · 179 mapped to Monday
  (~32%)** · 397 unique tag values in recent sample
- GoLogin: 18 active country profiles across EU/UK, MENA, ANZ, CA

**Follow-ups worth scheduling** (not blocking this session):

1. The **121 stuck-captcha jobs** — likely accumulated over many
   weeks. Run `release_stale_locks()` isn't the right tool (they're
   status=captcha, not stale locks). Needs an operator sweep via the
   scrape page's bulk-rerun or bulk-delete. Not urgent since they
   don't hold slots.
2. **EBS growth** — pending Ivan approval, then per the runbook.
3. **Monday sync cadence** — currently nightly. For the S-tag
   dashboard's *"is my mirror fresh?"* claim to remain accurate,
   consider a top-of-hour incremental sync via Vercel cron.

## Known issues

- **`FLEET_VM_COUNT` is now 2 but the third VM in AWS still exists**
  until the operator stops it. Between the code change (immediate)
  and the AWS-side change (tomorrow), locks acquired on the 3rd VM
  won't count against the utilization dashboard's *utilization%*
  denominator — you'll see it read >100% if the 3rd VM keeps working.
  Once the 3rd VM is stopped, this reconciles automatically.
- **The stuck captcha jobs** (121 as of this diagnostic) don't affect
  fleet capacity — they're not holding `active_profile_locks` — but
  they inflate the "started (last 24h)" metric on the utilization
  dashboard if they had been recently attempted.
