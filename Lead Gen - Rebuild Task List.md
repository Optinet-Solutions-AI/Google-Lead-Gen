# Lead Gen Platform — Incremental Rebuild Task List

**Status legend:** `[DONE]` shipped & verified · `[ENHANCED]` shipped with scope beyond original spec · `[BACKLOG]` not started

**Stack as built:** Next.js 16.2.3 (App Router, `proxy.ts`) · TypeScript · Tailwind v4 · Supabase (Postgres + RLS + RPCs + pg_cron) · GoLogin · AWS VM (3 workers per VM, ports 9222/9223/9224) · Vercel cron

---

## EPIC 1: Project Setup & Foundation — [DONE]

### 1.1 — Create New Repository — [DONE]
Reused existing `Google-Lead-Gen` repo from a fresh scaffold (commit `dad6746`). Next.js 16 App Router, TypeScript strict, Tailwind v4, ESLint configured.

### 1.2 — Provision Supabase Project — [DONE]
Project `veqfloktkejmyueskltp` provisioned. Supabase CLI linked. `npm run db:gen-types` script in place writing to `/types/supabase.ts`.

### 1.3 — Set Up Supabase Clients — [DONE]
Three clients via `@supabase/ssr`: server (`lib/supabase/server.ts`), browser (`lib/supabase/browser.ts`), and service role (`lib/supabase/service.ts`, `server-only` import). Service key never bundled to browser.

### 1.4 — Minimal UI Shell — [ENHANCED]
Built well beyond the original "minimal shell". Now includes:
- Collapsible sidebar (`dashboard-shell.tsx`) with rail mode + mobile drawer
- Peach color palette (`#FFB7A5` accent), Montserrat font, dark/light theme via Tailwind v4 `@theme` CSS variables
- Nav: Dashboard, Scrape, Schedules, Leads, Monday Data, Change Password, Sign out
- Admin auth (Admin/Admin123 → `admin@rooster.local`) with `/login` route, sign-out server action, account/password change page

### 1.5 — Deploy Skeleton to Vercel — [DONE]
Live on Vercel. All env vars configured (Supabase keys, Monday token, GoLogin token, cron secret).

---

## EPIC 2: Monday.com Data Import — [ENHANCED]

### 2.1 — Audit Monday Boards & Document Column Mapping — [DONE]
4 boards mapped: Leads, Affiliates, Not Relevant Leads, Email Undelivered Leads (+ updates).

### 2.2 — Create Monday Replica Tables Migration — [DONE]
4 tables shipped + an `updates` mirror table for activity. RLS enabled, no policies (service-role-only access).

### 2.3 — Build Monday.com API Client — [DONE]
Typed GraphQL client with cursor pagination + retry/backoff.

### 2.4 — Build One-Shot Import Script — [DONE]
Idempotent upsert by Monday `item_id`. All 4 boards imported successfully.

### 2.5 — Verify Import Data — [DONE]
Spot-checked, signed off.

### 2.6 — Real-time Webhook Sync — [ENHANCED — not in original plan]
`/api/monday/webhook` with `jose`-based JWT signature verification. Subscribed to all 4 boards. Updates land in Supabase within seconds of being made in Monday. Webhook route excluded from `proxy.ts` middleware.

### 2.7 — Monday Data UI — [ENHANCED — not in original plan]
`/monday/leads` (and 3 sibling pages) with:
- Server-side search, sort, filter, pagination (10 default — 10/25/50/100 options)
- Item drawer on row click showing all columns + linked updates
- Mobile card view, top mirror scrollbar, drag-to-pan, board nav as horizontal pills
- URL-driven state (`page`, `size`, `sort`, `order`, `q`, etc.) preserved on navigation

---

## EPIC 3: Feature 1 — Button-Triggered Google Scrape (Local) — [SUPERSEDED by Epic 5]

Original plan was local subprocess execution. We **skipped straight to the queue + VM worker model** because we already knew we needed multi-worker parallelism per country. The local-subprocess intermediate step would have been throwaway code.

What was kept from this epic:
- 3.1 — Confirmed the GoLogin scrape script works (renamed to `scraper.py`, parameterised `--port` and `--output`, reads `GOLOGIN_API_TOKEN` from env).
- 3.2 — `google_lead_gen_table` schema, but expanded directly to what Epic 7 will need: `is_affiliate`, `is_on_monday`, `is_rooster_partner`, `s_tag_id`, `brand` columns exist (currently null — populated by Epic 7).

---

## EPIC 4: Feature 1 Expanded — Multiple Keywords Per Country — [DONE]

### 4.1 — Schema for multi-keyword batches — [DONE]
`batch_id` is allocated atomically via `get_next_batch_id()` RPC. All rows from one enqueue share a batch.

### 4.2 — Multi-keyword enqueue server action — [DONE]
`enqueueScrape` server action (commit `78287ed`): parses textarea by `\n`, trims, dedupes, validates length ≤500, batch-inserts into `scrape_queue`.

### 4.3 — Multi-keyword input UI — [DONE]
Textarea (one keyword per line) with live count display + dynamic button text: "Start scraping" for 1, "Start N scrapes" for many, "Starting…" while pending. Submit disabled when count is 0.

### 4.4 — Manual verification — [DONE]
Verified end-to-end: 33-second round-trip per keyword.

---

## EPIC 5: Feature 1 Workers — AWS VM Execution — [ENHANCED]

### 5.1 — Provision AWS VM — [DONE]
EC2 instance running, Python + GoLogin + Chromium + selenium + bs4 + supabase-py installed. Scripts deployed via `curl` from public GitHub raw (avoids cloning the whole repo). `~/.env` holds credentials.

### 5.2 — Create scrape_queue Table — [ENHANCED]
Plus three additional tables:
- `gologin_profiles` (15 country profiles, seeded + matched to GoLogin via `scripts/gologin/sync-profiles.ts`)
- `active_profile_locks` (PK on `country_code` → enforces one concurrent scrape per country across all workers)
- `batch_counter` (atomic `get_next_batch_id()` source)

Plus atomic RPCs (all `SECURITY DEFINER` with pinned `search_path`):
- `claim_scrape_job()` — `FOR UPDATE SKIP LOCKED` + `INSERT … ON CONFLICT DO NOTHING` on country lock
- `complete_scrape_job(job_id, results jsonb, summary jsonb)` — multi-row insert via `jsonb_array_elements`
- `captcha_scrape_job()`, `fail_scrape_job()` — failure paths
- `release_stale_locks(threshold_minutes)` — safety net for crashed workers

### 5.3 — Replace synchronous scrape with queue insertion — [DONE]
Done from day one (we skipped Epic 3 local execution).

### 5.4 — VM queue worker — [ENHANCED]
`vm/worker.py` polls every 5s. Critical fix vs the original spec: subprocess output is redirected to a file on disk (`stdout=log_f, stderr=subprocess.STDOUT`) instead of `capture_output=True`, because GoLogin/Sentry/Chromium write >64KB of verbose output and were deadlocking the OS pipe buffer. Post-fix: 33-second end-to-end (was 13 min hung).

### 5.5 — VM Health Endpoint — [SKIPPED]
Not built. Not needed yet — workers log to `journald` and we can `journalctl -u scrape-worker@PORT -f` for now. Add only if we start needing UI-side VM health visibility.

### 5.6 — Queue Status UI — [DONE]
`/scrape` page shows enqueue form + jobs table + auto-refresh. `/scrape/[id]` drill-in shows job metadata + `LeadsTable` filtered by `scrape_job_id`. Search, sort, country filter, result-type filter, pagination (10 default).

### 5.7 — systemd service — [DONE]
Template unit `vm/scrape-worker@.service` with `%i` placeholder. Three instances active: `scrape-worker@9222`, `scrape-worker@9223`, `scrape-worker@9224`.

### 5.8 — Manual verification — [DONE]
Verified: 15-row batch landed cleanly, country locks prevented same-country double-claim, 3 different countries ran in parallel.

### 5.9 — pg_cron stale-lock release — [ENHANCED — not in original plan]
Migration `20260424100000_pg_cron_release_stale_locks.sql`: `cron.schedule('release-stale-scrape-locks', '*/5 * * * *', ...)` calling `release_stale_locks(30)`. Releases any lock held >30 min by a presumed-dead worker.

---

## EPIC 6: Feature 1 Scheduling — Scheduled Scraping — [DONE]

### 6.1 — Scheduler tables — [DONE]
`scheduled_keyword_sets` + `scheduled_keyword_items` shipped in core migration.

### 6.2 — Scheduler server actions — [DONE]
Built as Next.js server actions (not API routes): `createScheduledSet`, `updateScheduledSet`, `deleteScheduledSet`, `runScheduledSetNow`, plus item add/update/delete. Service-role client throughout.

### 6.3 — Vercel cron trigger — [DONE]
`/api/scheduler/tick` registered in `vercel.json` to run every minute (not 15 — we wanted finer granularity). Uses `cron-parser`'s `CronExpressionParser.parse` to compute `next_run_at`. Excluded from `proxy.ts` middleware. Guarded by `CRON_SECRET` header.

### 6.4 — Scheduler management UI — [DONE]
- `/schedules` — list view with name, schedule (human-readable), items, next/last run, active toggle
- `/schedules/new` — create form with cron preset dropdown + custom option
- `/schedules/[id]` — edit + items section + Run Now + Delete

### 6.5 — Manual verification — [DONE]
Verified end-to-end (`0bd4190`).

---

## EPIC 7: Enrichment Pipeline — Build Stage by Stage — [BACKLOG]

**Goal:** automate everything end-to-end in one run. **Approach:** build each enrichment stage as a standalone, manually-triggerable feature first, verify it on a real batch, then wire them together in Epic 8.

**Source of truth for prompts/heuristics/regex:** [docs/n8n-workflows-catalog.md](docs/n8n-workflows-catalog.md) — the legacy n8n pipeline already encodes years of domain knowledge (affiliate scoring rules, S-tag query-param ordering, contact-extraction prompt). Port verbatim where possible; replace only what's clearly worth re-deriving.

**Schema:** the relevant columns already exist on `google_lead_gen_table` (`is_on_monday`, `is_affiliate`, `is_rooster_partner`, `s_tag_id`, `brand`). Additional tables (`s_tags_table`, `contact_table`) will be added per-stage as needed — match the legacy schema from the catalog.

**Conditions / branching:** each stage produces flags that gate downstream stages. Detailed branch logic is intentionally deferred to Epic 8 (orchestration) — for now each stage is built to be runnable in isolation against any row.

---

### 7.1 — Stage: Monday Lead Duplicate Check
**Pipeline step 2 of 8.** Look up each scrape row's domain against our Supabase Monday mirrors (4 boards + their updates). Pure DB lookup — no external API calls.

- Port the legacy RPC `search_website_across_all_boards_and_updates(domain text)` from the catalog
- Add a domain-normalisation helper (strip protocol, www, paths, query)
- Index the website/domain columns on the 4 mirror tables
- Writes back: `is_on_monday` (bool), `monday_board` (which of the 4), `monday_item_id`
- UI: "Run Monday duplicate check" button per batch on `/scrape/[id]`
- Verify: pick 20 rows known to exist on Monday + 20 known not to, confirm precision/recall

### 7.2 — Stage: Affiliate Site Detection
**Pipeline step 3 of 8.** Classify each result URL as affiliate vs non-affiliate.

- Port the heuristic scorer from the catalog **verbatim** (15+ rules with point values — the catalog has them)
- Use Claude Opus 4.6 only as a tie-breaker on LOW/MEDIUM confidence rows (saves cost and latency, keeps deterministic where possible)
- Fetch destination HTML via the VM (avoid Vercel egress + serverless timeouts); follow redirects through trackers
- Writes back: `is_affiliate` (bool), `affiliate_confidence` (HIGH/MEDIUM/LOW), `affiliate_score` (int)
- UI: "Run affiliate detection" button per batch
- Verify: 20 known affiliates + 20 known non-affiliates → precision/recall ≥ 95%

### 7.3 — Stage: Rooster Partner Brand Check
**Pipeline step 4 of 8.** Determine if the destination URL belongs to a brand Rooster already represents (so we don't try to add ourselves as a lead).

- Match the redirected destination against `affiliates_table` (our Rooster brand list)
- Open question to resolve when we get here: did the legacy system use Serper.dev `site:` dorks, or DB lookup? The catalog mentions `rooster_partner_url_temp_holder_table` — read that section before deciding
- Writes back: `is_rooster_partner` (bool), `brand` (which Rooster brand matched)
- UI: badge in `LeadsTable`
- Verify: 10 known Rooster brand domains + 10 non-Rooster domains

### 7.4 — Stage: Contact Details Collection
**Pipeline step 5 of 8.** For non-affiliate, non-Rooster rows (actionable leads), find email + phone + contact-page URL.

- Replace legacy GPT-4o flow with **Claude Opus 4.6 + `web_search` tool** (catalog has the original prompt — adapt it)
- Hunter.io as fallback when web search returns no email
- New `contact_table` (port schema from catalog) linked to `google_lead_gen_table.id`
- UI: contact cell expands in `LeadsTable` drill-in
- Verify: 20 leads, manually compare extracted contacts against the live website

### 7.5 — Stage: S-Tag Extraction
**Pipeline step 6 of 8.** For affiliate rows, extract the S-tag (affiliate tracking ID) from the destination URL chain.

- Port the regex set + the **business-critical query-param key order** verbatim from the catalog: `['btag', 'stag', 'cxd', 'mid', 'affid']`
- Run on the VM — needs to follow redirect chains through trackers
- New `s_tags_table` (port schema from catalog) linked to `google_lead_gen_table.id`
- Writes back: `s_tag_id` on `google_lead_gen_table` (FK to `s_tags_table`)
- UI: S-tag column in `LeadsTable` (visible only for affiliate rows)
- Verify: 20 known affiliates, manually trace the redirect and compare extracted tag

### 7.6 — Stage: S-Tag Duplicate Check
**Pipeline step 7 of 8.** Check whether the extracted S-tag already exists on Monday (via our Supabase mirror).

- Port the legacy RPC `search_s_tag_across_all_boards_and_updates(tag text)` from the catalog
- Writes back: `s_tag_exists_on_monday` (bool), `s_tag_monday_item_id` (FK target for the next stage's update path)
- UI: badge alongside the S-tag column
- Verify: 10 known-existing tags + 10 fresh tags

### 7.7 — Stage: Monday.com Sync (Create or Update)
**Pipeline step 8 of 8.** Push enriched rows back to Monday — either create a new item or add an update on an existing one.

- Branch logic:
  - `s_tag_exists_on_monday` → `add_update` on the existing item (port the legacy "Add Updates for S-Tag" workflow)
  - else `is_affiliate && !is_on_monday` → `create_item` on Affiliates board
  - else `!is_affiliate && !is_on_monday && !is_rooster_partner` → `create_item` on Leads board
  - else (already on Monday OR is Rooster) → skip
- Use Monday GraphQL `create_item` / `create_update` — board IDs and column mapping are in the catalog
- Writes back: `monday_item_id` on `google_lead_gen_table`
- UI: "Push to Monday" button per row + per batch
- Verify: dry-run mode first (log the GraphQL payload without sending), then real push on 5 rows

---

## EPIC 8: Pipeline Orchestration — One-Run Automation — [BACKLOG]

**Goal:** when a scrape job completes, the full 7.1–7.7 chain fires automatically per row with the correct conditional branches. No human in the loop except for verification spot-checks.

### 8.1 — Per-row enrichment queue
New table `enrichment_queue` (or extend `scrape_queue` with a `stage` column). Each row tracks: `lead_id`, `current_stage` (1–7), `status`, `last_error`, `retry_count`, timestamps. Queue is poll-based, same pattern as `scrape_queue` but separate workers.

### 8.2 — Conditional branching engine
The "lots of conditions in between" gets centralised here, not scattered across stage workers. Reads stage outputs from `google_lead_gen_table`, decides whether the next stage should run for this row, or skip-to-end. Examples (preliminary — refine per stage when we get there):
- After 7.1 (Monday duplicate): if `is_on_monday` → skip 7.2–7.6, jump to 7.7 (might still need an update)
- After 7.2 (Affiliate): if `!is_affiliate` → skip 7.5–7.6 (S-tags only apply to affiliates), continue to 7.4 (contacts)
- After 7.3 (Rooster): if `is_rooster_partner` → skip 7.4–7.7 entirely (don't add ourselves)
- After 7.6 (S-tag duplicate): result decides create-vs-update path in 7.7

### 8.3 — Auto-trigger on scrape completion
Modify `complete_scrape_job` RPC to also enqueue rows into `enrichment_queue` at stage 1. Or add a Postgres trigger on `google_lead_gen_table` insert. Decide based on whether we want the option to scrape-without-enriching for debugging.

### 8.4 — Pipeline status UI
On `/scrape/[id]`: per-row stage indicator (1️⃣→7️⃣ progression with success/skip/fail/pending icons). On `/leads`: filter chip "fully enriched" vs "in progress" vs "stalled". Real-time updates via Supabase realtime channel.

### 8.5 — End-to-end manual verification
Run a fresh 10-keyword scrape. Verify: every row passes through the correct stages with correct branches, all writes land in the right tables, Monday gets the right creates and updates, no row stalls without an error message. Sign off → pipeline is "automated in one run". Goal achieved.

---

## BACKLOG

### B.1 — Google account sign-in on 15 GoLogin profiles (your task)
Each country profile needs to be signed into a Google account that has passed adult-content / age verification. Without this, PPC ads (sponsored results) don't render reliably for casino/gambling keywords. **One-time manual setup per profile.**

### B.2 — VM health endpoint (deferred from 5.5)
Only build if we start hitting silent worker outages.

### B.3 — Multi-VM scaling
Currently 1 VM × 3 workers. Architecture supports N VMs with no code changes (country-level locks coordinate through Postgres). Add a second VM only when we hit GoLogin bandwidth ceilings or queue depth becomes a problem.

---

## Summary

| Epic | Status | Notes |
|------|--------|-------|
| 1. Project Setup & Foundation | DONE | UI shell built well beyond minimal |
| 2. Monday.com Data Import | DONE + extras | + real-time webhook sync, + full Monday data UI |
| 3. Local Button Scrape | SKIPPED | Went straight to queue model |
| 4. Multi-Keyword Input | DONE | `78287ed` |
| 5. AWS VM Workers | DONE + extras | + country locks, + pg_cron stale-lock release, + 3 workers/VM |
| 6. Scheduling | DONE | `0bd4190` — every-minute tick |
| **7. Enrichment Pipeline (7 stages)** | **BACKLOG** | **Build stage-by-stage, verify each in isolation** |
| **8. Orchestration (one-run automation)** | **BACKLOG** | **Wire 7.1–7.7 together with conditional branches** |
| B.1 Google account sign-in (manual) | BACKLOG | Your task |

**End-to-end pipeline (final shape):**

```
Step 1 [DONE]      Scrape SERP
       ↓
Step 2 [Epic 7.1]  Monday lead duplicate check  ──┐
       ↓                                          │
Step 3 [Epic 7.2]  Affiliate detection          ──┤  branches resolved
       ↓                                          │  by Epic 8
Step 4 [Epic 7.3]  Rooster partner check        ──┤
       ↓                                          │
Step 5 [Epic 7.4]  Contact extraction           ──┤
       ↓                                          │
Step 6 [Epic 7.5]  S-tag extraction             ──┤
       ↓                                          │
Step 7 [Epic 7.6]  S-tag duplicate check        ──┤
       ↓                                          │
Step 8 [Epic 7.7]  Monday create-or-update      ──┘
```

**What's actually live:** Step 1 only. Steps 2–8 are the next build.

**Build order discipline:** finish 7.1 standalone (manual button + verification) before starting 7.2. Don't start Epic 8 until all of 7.1–7.7 work in isolation. Resist the urge to architect the orchestration first — the per-stage shape will inform what 8.2 needs to handle.

**Decision pending:** start Epic 7.1 now, or wait until B.1 (Google sign-in) is done so we have PPC rows in the data?
