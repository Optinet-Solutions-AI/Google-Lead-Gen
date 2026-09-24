# Porting brief: Google-Lead-Gen → lead-enrichment-platform

**For the agent working in `Optinet-Solutions-Prod/lead-enrichment-platform`.**

This describes work done in `Optinet-Solutions-AI/Google-Lead-Gen` after the two
codebases parted, written so you can re-implement it without reading our repo.
Where you need a file verbatim, ask your user — they can pull it from our repo
and paste it.

---

## 0. Before anything else — three facts that shape the whole port

**1. There is no shared git ancestor.** Your repo was seeded with copied
history, not forked. `git merge-base` between the two returns nothing. Every
commit hash below is a *reference for asking*, not something you can
cherry-pick. Re-apply by hand.

The last commit we have in common is *"feat(scrape): one batch per engine —
background Google PPC folded into the organic row"*, 2026-08-19 (`daaa254` in
our history, `cb24643` in yours). Everything below postdates it: **50 commits,
21 migrations**, through 2026-09-24.

**2. Monday.com is deliberately absent.** Your product is not tied to Monday, so
this brief never asks you to add it. But our codebase *is*, and several shared
features grew Monday branches. Anywhere that matters I give you the exact
predicate or column to leave out. §2 lists everything Monday that I have
omitted, so you can see the shape of the hole rather than wonder what I dropped.

**3. Check your framework version first.** We are on **Next 16.2.3 / React
19.2.4 / Tailwind 4**. Your repo was initialised as "Next.js 14+". If you have
not upgraded, the following will not port as written:

| Depends on | Used by |
|---|---|
| `params` / `searchParams` as a `Promise` | every page in §5, §6 |
| `useActionState` (React 19) | the website page's action panels |
| `experimental.staleTimes` | §8 router-cache tuning |
| Tailwind 4 syntax | all UI work |

Everything in §3, §4 and §9 is framework-agnostic (SQL, Python, a lib module) and
ports regardless. Do that first if you are behind.

---

## 1. What ports completely clean

Verified by grep: **zero** Monday references. Take these as-is.

| Thing | Where |
|---|---|
| Relevance screening | `lib/ai-analysis/relevance.ts` |
| AI crawl core (fetch, CTA extraction, unmask, brand attribution) | `lib/ai-analysis/core.ts` |
| Advanced search UI + RPC | `scrape/_components/advanced-search.tsx`, `_lib/job-search.ts`, migrations `20260921140000`, `20260921141000` |
| Website appearances table | `websites/_components/appearances.tsx` |
| Website-wide operator actions | `websites/actions.ts` |
| Affiliates screen | `affiliates/_lib/query.ts`, `_components/affiliate-list.tsx` |
| CTA noise cleanup | migrations `20260921100000`, `20260921101000` |
| Lead-domain functional index | migration `20260820150000` |
| Replay missing leads | migration `20260923120100` |
| Shared UI primitives | `_components/{modal,flag,source-icon,page-skeleton}.tsx` |

---

## 2. What I left out, and why

So you know the hole is deliberate. **Do not ask for these.**

Whole migrations, Monday-only: `20260820120000_carry_forward_manual_overrides`,
`20260820130000_monday_fuzzy_candidates`,
`20260820140000_monday_match_functional_indexes`,
`20260825120000_monday_match_updates_stem_tier`,
`20260923140000_inherit_monday_match`,
`20260923140100_backfill_monday_from_profile`.

Whole DB functions, Monday-only: `refresh_profiles_from_monday()`,
`propagate_profile_monday_to_leads()`, `mark_monday_duplicates_for_job()`,
`search_website_on_monday_all()`, `get_monday_mirror_freshness()`,
`inherit_monday_data_for_lead()`.

Whole screens: the Monday search page, the Monday board/updates views, the
push-to-Monday flows.

---

## 3. Website profiles — do this one first

Our migrations: `20260918120000_website_profiles.sql` + `…120100_backfill.sql`.

### The problem it solves

The lead table is a log of SERP appearances: the same website appears once per
keyword, per country, per run. Every verdict about a site — is it an affiliate,
whose brands does it push, who do we email — was copied onto each of those rows
and then drifted apart, because each row was enriched independently. There was
no object representing "this website".

### What to create

| Table | Holds |
|---|---|
| `website_profiles` | one row per website (`normalized_domain` unique), canonical verdicts |
| `website_appearances` | the log — every SERP sighting, with `created_lead` |
| `website_relations` | TLD/locale siblings of one brand |
| `known_non_affiliate_domains` | denylist feeding system flags |

`website_profiles` carries `is_affiliate`, `is_rooster_partner`, `brand`,
`has_contact_details`, `has_s_tags`, `system_flag`, `is_not_relevant`,
`first_seen_at`, `last_seen_at`, `appearance_count`, `first_lead_id`, and the
`*_checked_at` / `*_overridden_at` timestamps for each verdict.

**Omit** `is_on_monday`, `monday_board`, `monday_item_id`, `monday_match_kind`,
`monday_matched_at`, `monday_item_synced_at`, `monday_overridden_at`, and the
index `idx_website_profiles_monday_item`.

Supporting functions that are clean and worth having:
`link_profile_relations()`, `apply_db_system_flags()`,
`set_profile_system_flag()` — zero Monday references, verified.

### The trigger

`sync_lead_to_profile()` pushes verdicts from an edited lead back up to the
profile. Our version has a `-- monday ---` block (23 lines, resolving `is_on_monday` and
`monday_board` against the override and check timestamps). Skip that block —
it is contiguous and clearly delimited. Keep the rest, which resolves affiliate / rooster / contact / s-tag
the same way.

### The bug you must not reproduce

The dedupe that shipped with this kept **one lead row per website for all
time** — the predicate was `p.first_lead_id is null`. So the first scrape ever
to meet a domain wrote a row, and every later scrape of that domain wrote
none.

It went unnoticed for five days, because a scrape of mostly-new domains still
looks fine. Then an operator ran a batch of 21 results across 19 already-known
sites, got an **empty table under a header reading "21 results"**, and the
pipeline column was blank too because it counts leads.

Scope the dedupe **to the job** instead:

```sql
-- correct
where (not v_dedupe)
   or t.nd = ''
   or t.rn = (select min(t2.rn) from tmp_scrape_results t2 where t2.nd = t.nd);
```

First occurrence within one scrape's results wins, whatever earlier scrapes
found. Same-site duplicates still collapse (desktop + mobile passes, a site on
two result pages), which is all the dedupe was ever for. Cross-scrape history
lives in `website_appearances` and `appearance_count`, which is the point of
having them.

### Recovery tool worth porting

`replay_missing_leads(p_job_id uuid)` (migration `20260923120100`) rebuilds the
lead rows a completed scrape should have written, from the `raw_results` JSON
still held on the job — real titles, positions, inherited verdicts, no
re-scrape and no Apify spend. Idempotent: it skips any url the job already has.
Clean of Monday. We used it to restore 285 rows across 19 jobs.

---

## 4. AI analysis — two stages, both off by default

### Stage 0: is this result even about the keyword?

`lib/ai-analysis/relevance.ts` + migration `20260921160000`.

Judging only *"is this an affiliate?"* lets through porn sites, YouTube links,
social profiles and news articles — anything commercial-looking enough to pass.
A result has to be relevant to **the keyword that found it**, and the SERP
already tells you what each result is.

So screen before fetching anything: batch 20 results per OpenAI call (keyword +
domain + title + snippet, **no page fetch**), 5 batches concurrent. Write
`is_relevant` / `relevance_reason` / `relevance_checked_at` / `relevance_source`
on the lead, and a twelve-word `ai_site_description` on the **profile** — it
describes the website, not one appearance of it.

Then gate the expensive stage on it, so a rejected result is never opened,
never crawled and never charged for. `relevance_overridden_at` forces one
through.

Measured on a Norwegian batch: **300 judged for $0.043**, 70 rejected — an email
login page, a football news site, Wikipedia, Trustpilot, the national lottery
regulator, a video-games site. No false rejections found. ~$0.00015 per result.

**Prerequisite, and it is easy to miss:** the SERP snippet has to reach the
database. Apify returns it and our `worker.py` was discarding it. Both the
organic and PPC mappings need:

```python
"description": (o.get("description") or o.get("snippet") or ""),
```

Actor versions have called it either name. `complete_scrape_job` then persists
`serp_title` and `serp_description`. If you have historical rows, titles are
usually recoverable from the job's `raw_results` — we backfilled 83,838 of
85,402 that way.

### Stage 1: the affiliate crawl

`lib/ai-analysis/core.ts`, `run.ts`, migration `20260918140000`,
`app/api/ai-analysis/run/route.ts`.

curl fetches the page, **the model judges the content, and code handles the
links** — extraction, unmasking cloaked redirects, brand attribution. That
division is the durable lesson: the model returned usable hrefs only ~10% of the
time from a text fetch, and judged *what a page is* reliably. ~$0.002/site.

Writes `ai_worth_checking`, `ai_is_affiliate`, `ai_affiliate_reason`,
`ai_brands`, `ai_cta_count`, `ai_emails`, `ai_phones`, `ai_contact_page_url` to
the profile, plus a `website_cta_links` table.

**Port the two cleanup migrations with it** (`20260921100000`,
`20260921101000`). Our first CTA counts were inflated by roughly a quarter: the
cloak regex matched content words like `/bonuses/`, plus payment and vendor
links, plus locale siblings of the site itself. 800 links → 637 after narrowing
`CTA_CLOAK`, adding a vendor-host denylist, and requiring a CTA to actually
leave the site.

**Monday strip:** `ai_candidates_for_job()` (created in `20260918140000`,
amended in `20260921161000`) filters `and p.is_on_monday = false` — "don't spend
AI on sites we already have". Drop that predicate, or substitute your own notion
of an already-known account. Keep the rest of the trim (`is_not_relevant`,
`system_flag`, and the relevance gate).

**Environment gotcha:** our key is stored as `OPENAI_APIKEY` while the code
reads `OPENAI_API_KEY`. Do not inherit that.

---

## 5. A page per website

`app/(dashboard)/websites/**`.

Clicking a domain used to open a 1,743-line drawer over the table — so the page
you were on was a lead row while the thing you were reading was a website.
Replaced with `/websites/[domain]`.

Layout, full width, in the order the question is actually asked:

1. **Header** — domain, AI description, first/last seen, appearance count, actions
2. **Verdict tiles** — already exists, on keyword, affiliate, Rooster brand, contacts, s-tags
3. **Appearances** — the per-row facts: keyword, country, position, device, batch
4. **Details** — the evidence, as cards flowing across 2–3 columns

Things that cost us time:

- **Resolve appearances by `profile_id`, never by the lead's `domain` column.**
  That column stores the full origin (`https://www.example.com`), so matching a
  bare domain against it silently returns nothing. Every lead row has a profile
  id; use it.
- Operator actions are **website-wide**, applied to every appearance and written
  onto the profile. A news site does not become relevant because a different
  keyword turned it up.
- **Omit empty sections** rather than rendering a column of `—`. Our first
  version also rendered a raw SOCKS stack trace as an "affiliate indicator";
  long indicators now collapse to a summary you can expand.
- **Split the page across a Suspense boundary.** Profile + appearances are two
  indexed queries; contacts, s-tags, the cohort RPC and signed screenshot URLs
  are not. Holding them all in front of first byte cost 3.6s. Behind a boundary:
  0.99s. Wrap the expensive loader in React `cache()` — two boundaries await it
  and would otherwise each pay full price.
- **Cap what you fetch.** Appearances were pulling 500 rows into a 560px scroll
  box. 100 is plenty; report the true total from `appearance_count`.
- `?from=` carries where Back should return to, honoured **only for same-origin
  paths** — an absolute URL there is an open redirect.

**Monday strip:** our `website-detail.tsx` has 88 Monday references — a "Monday
duplicate check" section, a fuzzy `PossibleMondayMatches` panel, and two
push-to-Monday panels. Drop all four. What remains (affiliate detection, Rooster
check, contacts, s-tags, owner network, screenshots) is what you want.

---

## 6. "Already exists?" — the idea, minus Monday

We merged two yes/no columns into one badge that says **where** a website is
already known. The precedence logic is worth keeping even though one of our
sources does not exist for you:

> Scraping a site puts it in our system **by definition**. So "known externally
> but not in the system" cannot happen, and "in the system" only means anything
> once the external source has been ruled out. External source wins; our own
> history is the fallback; anything left is genuinely new.

For you today that collapses to two states — **In system** / **New** — computed
as:

```
profile.first_seen_at < lead.created_at - interval '1 minute'  →  In system
otherwise                                                      →  New
```

The minute of slack stops rows *within one batch* marking each other as
pre-existing. We verified this cheap test against an appearance-walking SQL
function over 300 rows: identical on every one, so prefer the cheap version.

Keep the three-way shape in the code even while one branch is unreachable — if
you add a CRM or billing source later, that is the slot it goes in.

Two implementation notes:

- In our repo the badge unfortunately lives **inside** `monday-label-editor.tsx`
  (27 Monday references) because the badge doubles as the editor trigger. Do not
  copy that. Build a standalone `ExistsBadge` and keep editing separate.
- Show *only* the state on the badge; put detail and the last-checked timestamp
  in the tooltip. And be honest about staleness — a row whose check has never
  run should read "never checked", not imply the answer is current. We nearly
  shipped a `coalesce(checked_at, now())` that would have stamped an insert as a
  verification.

---

## 7. Counts must be derived from the thing they describe

This is the most transferable lesson here, and it is three lines of code.

Our scrape list showed a Results column read from `result_summary.organic_results`
— how many results the *search* returned. The table below it renders *rows*.
Those are different numbers with no invariant between them, so when the dedupe
bug suppressed inserts, the column cheerfully advertised "21 results" over a
batch that opened empty. The count was not wrong about its own source; it was
answering a different question from the one the reader was asking.

Count real rows, and account for every one that is missing:

> 21 results from the search · 2 same-site duplicates collapsed · 19 rows stored
> · 6 hidden as not relevant · 1 hidden by a system flag · 12 shown

We get those counts from rows already fetched for the pipeline-status dots, so
it costs no extra query. The batch header does the same arithmetic. If a number
ever disagrees with the table again, it now says so instead of hiding it.

**Monday strip:** `job_analysis_summary()` (migration `20260921170000`) returns
an `on_monday` column and a three-way `existing_state`. Make it two-way. The
rest of the function — relevance counts, affiliate counts, distinct domains —
is unaffected.

---

## 8. Performance

We measured before changing anything, and the database was never the problem:
the appearance query is 5ms, the cohort RPC 68ms, the heaviest lookup 242ms. The
cost was **serial round trips with nothing on screen**.

- **`loading.tsx` on every dynamic page.** Exactly one of our 34 had one. Without a
  loading boundary Next blocks the transition entirely — the old page stays
  frozen and nothing tells the user the click registered. A shared
  parameterised skeleton (`rows`, `stats`, `controls`) covers all of them.
- `experimental.staleTimes: { dynamic: 30, static: 180 }` for the router cache.
- Stream the expensive half of a page behind Suspense (§5).
- Stop fetching what nobody sees (§5).

Result: 1.0–2.1s → 0.59–0.73s time-to-first-byte across the app; the website
page 3.6s → 0.56–0.99s. Local dev numbers; production sits closer to the
database, so absolutes are lower but the shape holds.

---

## 9. The August stretch — small, load-bearing, easy to skip

- **`20260820150000_lead_domain_functional_index.sql`** — a functional index on
  the lead-domain expression. Without it `complete_scrape_job` starts timing out
  as the table grows. Three lines. **Do this early**; it is an unpleasant thing
  to diagnose cold.
- **Affiliate stage always scores** — the score used to require a full
  enrichment pass, so partially-enriched leads carried none. Score from whatever
  is available.
- **Apify → VM fallback** — when Apify persistently errors on a job, fall back to
  the VM browser rather than failing the batch.
- **PPC ad extraction** — wait for the real `/aclk` ad anchor, not the
  "Sponsored" label, which Google stopped rendering.
- **`20260901120000_chain_stops_at_rooster.sql`** — the enrichment chain now
  **stops at the Rooster stage**; contact extraction and s-tags became manual.
  This changes how your pipeline terminates, so decide deliberately rather than
  copying. **Monday strip:** `advance_enrichment_chain()` guards each stage with
  `(force_enrich = true or is_on_monday is not true or monday_inherited_at is
  not null)` and calls `inherit_monday_data_for_lead()` at the top. Drop the call
  and reduce each guard to `force_enrich = true or <your own skip condition>`.

---

## 10. `complete_scrape_job` — the one function you will fight

It is 308 lines and we rewrote it four times in this window (adding SERP
title/description, fixing the dedupe, Monday inheritance, then the timestamp
honesty fix). **Do not apply those four in sequence.** Take our final definition
and strip Monday in four places:

1. The insert **column list** — remove `is_on_monday, monday_board,
   monday_item_id, monday_match_kind, monday_checked_at, monday_overridden_at`.
2. The corresponding six **select expressions** (`p.is_on_monday`,
   `p.monday_board`, `p.monday_item_id`, `p.monday_match_kind`,
   `p.monday_matched_at`, `p.monday_overridden_at`).
3. Two occurrences of `and p.is_on_monday is not true` in the verdict-expiry
   re-check enqueues (affiliate and rooster).
4. The trailing `perform public.mark_monday_duplicates_for_job(p_job_id);`.

Nothing else in the function is Monday-aware. Ask your user for the final file
(`supabase/migrations/20260923150000_no_invented_check_time.sql`) and make those
four edits.

---

## 11. Suggested order

1. Lead-domain functional index (§9) — three lines, prevents a timeout
2. Website profiles + **job-scoped** dedupe (§3) — everything else sits on it
3. SERP snippet capture in the worker + title backfill (§4)
4. Relevance screening (§4) — cheapest, highest-signal change on its own
5. Accurate result counts (§7) — small, kills a whole class of bug
6. `loading.tsx` + shared skeleton (§8)
7. The website page (§5) — the largest single piece
8. AI crawl (§4), the rest of §9

---

## 12. Sanity checks once you are done

- Scrape a keyword whose results are **all already-known domains**. You should
  get a full table, not an empty one. This is the regression that motivated §3.
- Compare the Results column against the row count in the batch it links to.
  They must agree, or the difference must be named on screen (§7).
- Run the relevance screen on ~100 results and read the rejections. Ours caught
  an email login page and a lottery regulator; if yours is rejecting plausible
  affiliates, the prompt needs your vertical's vocabulary.
- Navigate between three pages and confirm something paints immediately (§8).
- Open a website page for a domain with 500+ appearances and check first byte.

Anything here that does not match what you find, ask — some of it is specific to
our data shape and may not survive contact with yours.
