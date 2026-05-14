# Bug punch-list — 2026-05-14 multi-agent review

40 items found across server actions, API routes, lib/, UI components, pipeline + scripts.
Tick items as you fix them. `✱` = found by 2+ independent reviewers.

---

## CRITICAL — security / privilege escalation

- [ ] **1. ✱ Service-role mutations have no admin check** — any signed-in user can flip brands, GoLogin login state, delete schedules, run any schedule, or trigger full Monday sync
  - `app/(dashboard)/brands/actions.ts:62, 86, 109, 132`
  - `app/(dashboard)/profiles/actions.ts:20, 44, 74`
  - `app/(dashboard)/schedules/actions.ts:165, 180, 248, 262`
  - `app/(dashboard)/monday/_actions/sync.ts:21`
  - Fix: add `is_admin` RPC gate like `admin/*` actions already use

- [ ] **2. Fail-open cron/sync auth** when `CRON_SECRET` is unset/empty
  - `app/api/monday/sync/route.ts:26`
  - `app/api/scheduler/tick/route.ts:26`
  - Fix: `if (!secret) return 500`, then require bearer match unconditionally

- [ ] **3. ✱ Monday webhook JWT has no replay protection** — captured token valid forever
  - `lib/monday/webhook-verify.ts:33-69` — no `maxTokenAge`, no `iat` window
  - `app/api/monday/webhook/route.ts:28` — body read before verification; challenge handshake unsigned
  - Fix: enforce `maxTokenAge: '5m'` + `iat` freshness; verify before parsing JSON

- [ ] **4. Hardcoded prod admin credentials in repo** — `admin@rooster.local` / `Admin123` re-applied each run
  - `scripts/auth/seed-admin.ts:22-23`
  - Fix: require `ADMIN_PASSWORD` env, refuse to run on prod without explicit flag

- [ ] **5. Cross-job data leak in stage-summary queries** — fetches all tag rows in DB, not scoped
  - `app/(dashboard)/scrape/_lib/queries.ts:113-122` (`fetchStageSummary`)
  - `app/(dashboard)/scrape/_lib/queries.ts:302-309` (`fetchEnrichmentStatus`)
  - Fix: scope by `.in('lead_id', leadIds)`

- [ ] **6. Bulk-delete clobbers admin's own session** — `signInWithPassword` on cookie-bound client rotates the session
  - `app/(dashboard)/scrape/actions.ts:1265`
  - `app/(dashboard)/account/password/actions.ts:44-50`
  - Fix: use separate anon client with `persistSession: false` for password verification

- [ ] **7. Non-constant-time bearer token compare** (timing oracle)
  - `app/api/monday/sync/route.ts:28`
  - `app/api/scheduler/tick/route.ts:28`
  - `app/api/enrichment/score-row/route.ts:28`
  - Fix: `crypto.timingSafeEqual`

---

## HIGH-UX — silent failures (same family as recent fixes)

- [x] **8. ✱ Silent no-op toggles** — same pattern as 5e5cb95 /leads Restore fix
  - `app/(dashboard)/brands/_components/brand-row.tsx:45-51` (ActiveToggle.flip)
  - `app/(dashboard)/profiles/_components/profile-row.tsx:87-95` (ToggleCell.flip)
  - Fix: try/catch with surfaced error pill (copy NameField pattern)

- [x] **9. Silent error swallow in schedule mutations** — failed delete returns 200 OK
  - `app/(dashboard)/schedules/actions.ts:165, 180, 248, 262`
  - Fix: capture `{ error }` and throw

- [x] **10. Sort `order=asc` ignored on `result_type` column** — echoes 26c1fa7
  - `app/(dashboard)/leads/_lib/query.ts:151` — line 143 forces DESC even when asc requested
  - Fix: override line-143 when `sort==='result_type'`

- [x] **11. Render-time `queueMicrotask` fires every render after success**
  - `app/(dashboard)/scrape/_components/bulk-actions-bar.tsx:126`
  - `app/(dashboard)/scrape/_components/job-row-actions.tsx:346-348`
  - `app/(dashboard)/leads/_components/bulk-actions-bar.tsx:221`
  - Fix: wrap in `useEffect` keyed on action state

- [x] **12. "All complete" badge is unreachable** — checks `doneCount === 6` but max is 5
  - `app/(dashboard)/scrape/_components/enrichment-stages.tsx:310`
  - Fix: `=== 5`

- [x] **13. Hydration mismatch on user-create form** — `Math.random()` during render
  - `app/(dashboard)/admin/users/_components/add-user-form.tsx:25-27`
  - Fix: init empty, populate in useEffect

- [x] **14. Pagination + filter changes scroll-jump to top**
  - `app/(dashboard)/monday/_components/pagination.tsx:43-48`
  - `app/(dashboard)/leads/_components/leads-filters.tsx:21-27`
  - Fix: `router.push(..., { scroll: false })`

---

## LOGIC — data correctness

- [ ] **15. ✱ Cron-tick race / no atomic claim** — overlapping ticks double-enqueue
  - `app/api/scheduler/tick/route.ts:97-104, 129-137`
  - Fix: atomic `UPDATE … RETURNING` or `pg_try_advisory_lock`

- [ ] **16. Cron skips missed firings** — no catch-up after pause/resume or missed Vercel tick
  - `app/api/scheduler/tick/route.ts:81-85`
  - Fix: `currentDate: max(set.next_run_at, now - 1ms)`

- [ ] **17. `notempty` / `empty` filter asymmetry** — same text row matches both
  - `lib/filters/apply.ts:87`
  - Fix: `q.not(key,'is',null).neq(key,'')` for text columns

- [ ] **18. Filter serialize round-trip drops empty fields, corrupts `between`**
  - `lib/filters/serialize.ts:19-26`
  - Fix: sentinel placeholder, or refuse to serialize `between` missing v

- [ ] **19. Affiliate-score "pros/cons" false positive on most pages** — matches "process", "prospectus", "consider", "console"
  - `lib/affiliate-detection/scorer.ts:245`
  - Fix: `pros:` / `cons:` colon form, or `\bpros\b` word boundary

- [ ] **20. `www.x.com` domain stem collapses to `"www"`** — token collides across all sites
  - `lib/affiliate-detection/rooster.ts:55`
  - Fix: `dom.replace(/^www\./,'').split('.')[0]`

- [ ] **21. Monday sync truncates mid-stream on empty-string cursor**
  - `lib/monday/sync-runner.ts:121` — `!page.cursor` treats `""` as terminal
  - Fix: `page.cursor == null`

- [ ] **22. Push-to-Monday writes malformed s-tag rows when one side empty**
  - `lib/monday/push-lead.ts:294`
  - Fix: require both `brand` and `s_tag` non-empty

- [ ] **23. `language === 'en'` bypasses country allow-list**
  - `app/(dashboard)/scrape/actions.ts:138-139`
  - Fix: drop the `|| language==='en'` short-circuit

- [ ] **24. `toggleScheduledItem` is racy read-modify-write** — concurrent clicks clobber
  - `app/(dashboard)/schedules/actions.ts:248`
  - Fix: RPC with `is_active = NOT is_active` server-side

- [ ] **25. Feedback `resolved_by` / `resolved_at` wiped when status reverts to open** — loses audit history
  - `app/(dashboard)/admin/feedback/actions.ts:121-126`
  - Fix: only set on transition into terminal state

- [ ] **26. datetime-local interpreted in server TZ (UTC), not user's TZ**
  - `app/(dashboard)/scrape/actions.ts:97`
  - Fix: convert on client with `toISOString()`, or label form as UTC

- [ ] **27. Cross-job control endpoints owner-unchecked** — mutate any `job_id`
  - `app/(dashboard)/scrape/actions.ts:32-36` (`checkMondayDuplicates`, `pauseScrapeJob`, `resumeScrapeJob`, `runAffiliateDetection`)
  - Fix: `eq('created_by_email', user.email)` or admin gate

---

## MEDIUM — error leakage / minor logic

- [ ] **28. Supabase error messages leak schema names** in 500 responses
  - `app/api/leads/[id]/route.ts:32-33`
  - `app/api/enrichment/score-row/route.ts:63, 71, 206, 269, 548`
  - `app/api/monday/webhook/route.ts:69-71`

- [ ] **29. Stage-timing comparison uses ISO string `>`** — breaks on `+00` vs `Z`
  - `app/(dashboard)/scrape/_lib/queries.ts:413`

- [ ] **30. `isSafePath` allows `\r\n` and backslash paths**
  - `app/login/actions.ts:42-44`

- [ ] **31. `countOccurrences` interpolates pattern into RegExp without escaping** (latent footgun)
  - `lib/affiliate-detection/scorer.ts:108-115`

- [ ] **32. GoLogin profile sync silently caps at 200**
  - `scripts/gologin/sync-profiles.ts:49`

- [ ] **33. `htmlToText` decodes entities before stripping tags** — entity-encoded tag injection
  - `lib/llm-fallback/borderline-classifier.ts:34`

- [ ] **34. Bulk script writes activity_log rows with `null` operator** — no audit attribution
  - `scripts/qa/clear-redundant-overrides.ts:181-198`
  - `scripts/qa/clear-glue-bug-overrides.ts:134`

- [ ] **35. `apply-migration.ts` has no dry-run / prod guard** — arbitrary SQL on prod
  - `scripts/db/apply-migration.ts:40-62`

- [ ] **36. Scheduler tick risks Vercel 10s timeout** under 50-job enrichment chains
  - `app/api/scheduler/tick/route.ts:131` — sequential awaits

- [ ] **37. Hunter API key sent in query string** (proxy/log exposure)
  - `lib/contact-extraction/hunter.ts:31`

- [ ] **38. `guessBrandFromUrl` mangles `.co.uk` / `.com.au` brands** — `casino.co.uk` → `"casino.co"`
  - `lib/stag-extraction/extract.ts:101-110`

- [ ] **39. Phone regex passes garbage when country code missing**
  - `lib/contact-extraction/extract.ts:17`
  - `lib/contact-extraction/phone-validate.ts:20`

- [ ] **40. Confirmation-text compare mistrims one side**
  - `app/(dashboard)/scrape/actions.ts:957-977`

---

## Suggested order

1. Knock out **#8** and **#10** first — same family as recent fixes, fastest wins
2. Then **#1** (admin gate) — mechanical, copy existing pattern, big security impact
3. Then **#11** (render-time microtask) — appears 3x, single pattern to fix
4. Then critical security cluster (**#2, #3, #4, #6, #7**)
5. Then logic correctness (**#15-27**)
6. Polish/medium last

## Counts
- 7 critical
- 7 high UX
- 13 logic
- 13 medium

**Total: 40 items**
