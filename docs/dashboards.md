# Dashboards catalog

Operator-facing pages plus their audience, data source, and what
to do when they show unexpected numbers.

| Route | Audience | Purpose |
| ----- | -------- | ------- |
| [`/`](../app/(dashboard)/page.tsx) | Everyone | Overview — headline KPIs, recent activity |
| [`/scrape`](../app/(dashboard)/scrape/page.tsx) | Everyone | Enqueue new scrapes; see recent jobs with live status |
| [`/leads`](../app/(dashboard)/leads/page.tsx) | Everyone | Filtered lead browser; push to Monday |
| [`/monday/leads`](../app/(dashboard)/monday/[board]/page.tsx) | Everyone | Read-only view of the mirror of every Monday board |
| [`/stag-mapping`](../app/(dashboard)/stag-mapping/page.tsx) | Everyone | S-tag groups → same-operator detection |
| [`/profiles`](../app/(dashboard)/profiles/page.tsx) | Everyone | GoLogin country-profile status |
| [`/brands`](../app/(dashboard)/brands/page.tsx) | Everyone | Rooster brand-domain registry |
| [`/activity`](../app/(dashboard)/activity/page.tsx) | Everyone | Audit log |
| [`/admin/interactive`](../app/(dashboard)/admin/interactive/page.tsx) | Everyone (for captcha resolution) | Live noVNC checkpoint queue |
| [`/admin/utilization`](../app/(dashboard)/admin/utilization/page.tsx) | Admin only | Fleet utilization, queue depth, per-user caps |
| [`/admin/operations`](../app/(dashboard)/admin/operations/page.tsx) | Admin only | Cost + bandwidth |
| [`/admin/system`](../app/(dashboard)/admin/system/page.tsx) | Admin only | System settings |
| [`/admin/users`](../app/(dashboard)/admin/users/page.tsx) | Admin only | Add / edit / disable users |
| [`/admin/alerts`](../app/(dashboard)/admin/alerts/page.tsx) | Admin only | Alert-recipients config |
| [`/admin/feedback`](../app/(dashboard)/admin/feedback/page.tsx) | Admin only | QA feedback triage |

## `/admin/utilization` — Fleet utilization dashboard

Server-rendered, auto-refresh 30 s. Answers: *is the fleet busy? are
users hitting the cap?*

**Sections:**

- **Fleet capacity & live workers** — 5 tiles (slots-in-use with tone,
  pending-ready backlog, 24h started/completed, avg + max job
  duration, theoretical throughput). Table of `active_profile_locks`
  underneath.
- **Daily volume** — 14-day bar chart of `scrape_queue` insert counts
  by UTC day. Peak day highlighted.
- **Country distribution (14d)** — sorted list, fill-bar per country.
- **Per-user cap adherence (7d)** — one row per email, one column per
  day. Cells that hit the daily cap are highlighted amber.

**Data source:** `scrape_queue`, `active_profile_locks`,
`user_profiles`, live values of `system_settings.max_concurrent_per_country`
and `daily_scrape_cap_per_user`.

**Fleet dimensions:** `lib/fleet.ts` (constants).

## `/stag-mapping` — S-tag mapping dashboard

Server-rendered on every load; interactive client-side filter + expand.
Answers: *which websites share an S-tag (same operator, mirror domains),
which S-tags are already on Monday, which are new opportunities.*

**Sections:**

- **Monday-mirror freshness banner** — green/amber/red per board age.
- **Summary tiles** — unique S-tags, mapped %, unmapped, mirror groups
  (2+ domains), distinct websites, total leads with tags.
- **Interactive S-tag table** — grouped by tag value, showing param,
  brand, website count, lead count, last-seen, Monday status. Click
  a row to expand: distinct domains carrying the tag, per-lead
  drill-down with Monday-board and outbound-link columns.
- **Monday mirror status** — per-board `synced_at` age with tone.

**Filter chips:** All / Mapped / Unmapped / Mirror groups.
**Search:** matches against S-tag value, brand, or any domain.
**URL param:** `?days=N` (default 90; range 1–365) controls the lookback.

**Data source:** `s_tags_table` joined with `google_lead_gen_table`;
`leads_table` / `affiliates_table` / `not_relevant_leads_table` /
`email_undelivered_leads_table` for freshness.

**Admin action:** *Sync Monday now* button triggers an incremental sync
of all 4 boards (same code path as the nightly cron). Failures are
non-blocking; the existing sync watermark keeps the mirror consistent.

## `/scrape` enqueue-form additions (2026-07-19)

Not a standalone dashboard, but adds live fleet-load awareness to
the primary user surface:

- **FleetLoadPill** (collapsed header) — always-visible color-coded
  chip: idle / N slots busy / N queued.
- **FleetLoadBanner** (expanded form) — shown when fleet ≥60% busy;
  includes fleet-wide backlog drain-time estimate.
- **CountryQueueBadge** (under country picker) — per-country slots
  busy, pending count, per-country wait ETA.
- **Country dropdown** options carry inline `(3/3 · +5 pending)`
  hints so users self-route to less busy countries.
- **Submit button** — dynamic label including estimated start-time
  (e.g. `Queue 8 scrapes — starts in ~12 min`).
- **Success toast** — post-insert queue peek: `"— you're #7 in the
  AU queue · come back in ~14 min."`
- **QueuePositionBadge** — on every `pending` row in the jobs table,
  shows `#N · ~Xm`, refreshes every 5 s along with the auto-refresh
  cycle.

All of the above reads from a single server query:
`getFleetQueueSnapshot()` in
[`app/(dashboard)/scrape/_lib/queries.ts`](../app/(dashboard)/scrape/_lib/queries.ts).
