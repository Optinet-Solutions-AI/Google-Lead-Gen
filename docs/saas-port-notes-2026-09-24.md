# What changed in Google-Lead-Gen since the SaaS fork

**Scope:** everything after `daaa254` "one batch per engine" (2026-08-19) — the
last commit this repo and the SaaS repo share. 50 commits, 21 migrations, up to
2026-09-24.

Confirmed against `Optinet-Solutions-Prod/lead-enrichment-platform`: its history
carries ours as far as `cb24643` (same subject, 2026-08-19) and then diverges
into its own work — Stripe pre-wiring, org switching — with its last commit on
2026-09-14. The two repos share no git ancestor, so nothing can be cherry-picked
directly; these are changes to re-apply, not to merge.

Monday.com work is left out as requested. Where something is only *partly*
Monday-coupled, it's called out under **In the SaaS version** so you know what
to drop rather than discovering it at runtime. Four commits in the delta are
purely Monday and don't appear below at all: manual tag overrides + Updates
sync (`8f845ac`), fuzzy match candidates (`d83c875`), match-tier indexes
(`f242cd5`), TLD-variant auto-matching (`1c7b336`).

---

## 0. August 20 – September 1 — the stretch before the big push

Small but load-bearing, and easy to skip because the headline features came
later.

- **`20260820150000_lead_domain_functional_index.sql`** (`6550e08`) — a
  functional index on the lead-domain expression. Without it
  `complete_scrape_job` was timing out as the table grew. Port this early; it is
  three lines and it stops a failure mode you would otherwise have to diagnose
  from scratch.
- **Affiliate stage always scores** (`77fcec1`) — the affiliate score used to
  require a full enrichment pass, so partially-enriched leads carried no score
  at all. Now it scores from whatever is available.
- **Apify → VM fallback** (`cc06d2f`) — when Apify persistently errors on a job,
  the scrape falls back to the VM browser instead of failing the batch.
- **PPC ad extraction** (`3e38493`) — wait for the real `/aclk` ad anchor rather
  than the "Sponsored" label, which Google had stopped rendering. Three earlier
  commits in this range (`9fcc82d`, `a2dcc73`, `e0c98fa`) added a diagnostic for
  this and then reverted it once the question was answered — nothing to port.
- **Scheduled-scrape timezone** (`07afdf0`) — per-schedule timezone selector,
  defaulting to Malta.
- **Enqueue form reset** (`68ad8e9`) — country and language reset after a
  successful enqueue.
- **`20260901120000_chain_stops_at_rooster.sql`** (`9027cee`) — the enrichment
  chain now **stops at the Rooster stage**; contact extraction and s-tags became
  manual steps. This changes how the pipeline terminates, so if the SaaS repo
  still auto-runs the full chain, decide deliberately whether to follow.

---

## 1. Website profiles — the one that changes everything else

`20260918120000_website_profiles.sql`, `…120100_backfill.sql` (commit `639eb85`)

The lead table was a log of SERP appearances: the same website appeared once per
keyword, per country, per run. Every verdict about a site — is it an affiliate,
whose brands, who do we email — was copied onto each of those rows and drifted
apart. Four new tables/concepts:

| Table | Holds |
|---|---|
| `website_profiles` | one row per website, canonical |
| `website_appearances` | the log: every time a site turned up in a SERP |
| `website_relations` | TLD/locale siblings of the same brand |
| `known_non_affiliate_domains` | denylist feeding system flags |

21,802 profiles backfilled. The profile carries the verdicts (`is_affiliate`,
`is_rooster_partner`, `has_contact_details`, `has_s_tags`, `system_flag`,
`is_not_relevant`) plus `first_seen_at` / `last_seen_at` / `appearance_count`.
`complete_scrape_job` inherits them onto each new lead row, subject to a TTL per
verdict (`verdict_ttl_days` system setting: affiliate 90d, rooster 60d, contact
180d, s-tags 90d).

**Read this part before you port it.** The dedupe shipped with this work kept
**one lead row per website for all time** (`p.first_lead_id is null`). The first
scrape ever to meet a domain wrote a row; every later one wrote none. Nobody
noticed for five days because a scrape of mostly-new domains still looks fine.
Then an operator ran a batch of 21 results across 19 known sites and got an
empty table under a header reading "21 results". Fixed in
`20260923120000_scrape_shows_its_results.sql` by scoping dedupe **to the job**:
first occurrence within one scrape's results wins, regardless of history. Same-
site duplicates (desktop + mobile passes, a site on two result pages) still
collapse, which is all the dedupe was ever for.

`20260923120100_replay_missing_leads.sql` rebuilds the rows a completed scrape
should have written, from the `raw_results` JSON still held on the job — real
titles, positions and inherited verdicts, no re-scrape. Idempotent. Worth
porting even if you never hit the bug; it's a generally useful recovery tool.

**In the SaaS version:** drop `is_on_monday`, `monday_board`, `monday_item_id`,
`monday_match_kind`, `monday_matched_at`, `monday_overridden_at` from
`website_profiles` and the corresponding inheritance in `complete_scrape_job`.
Everything else stands alone.

Supporting lib: `lib/website-profiles/recency.ts` (the colour bands for
"how recently was this site seen"), `cet.ts`, `system-flag-llm.ts`.

---

## 2. AI analysis pipeline

Two stages, both off by default behind system settings.

### Stage 0 — relevance to the keyword (`a4d31e9`)

`lib/ai-analysis/relevance.ts`, `20260921160000_serp_snippet_and_relevance.sql`

Judging only "is this an affiliate?" let through porn sites, YouTube links,
social profiles and news articles — anything commercial-looking enough to pass.
A result has to be relevant to the **keyword that found it**, and Google already
tells us what each result is.

So screen on the SERP itself, before anything is fetched: batch 20 results per
OpenAI call (keyword + domain + title + snippet, no page fetch), 5 batches
concurrent. Writes `is_relevant` / `relevance_reason` / `relevance_checked_at`
on the lead, and a twelve-word `ai_site_description` on the *profile* — it
describes the website, not one appearance of it.

`ai_candidates_for_job()` then skips rejected leads
(`20260921161000_candidates_require_relevance.sql`), so an irrelevant result is
never opened, never crawled and never charged for. `relevance_overridden_at`
forces one through.

Validated on a Norwegian batch: 300 judged for **$0.043**, 70 rejected — an
email login page, a football site, Wikipedia, Trustpilot, the national lottery
regulator, a video-games site. No false rejections found. ~$0.00015/result.

**Prerequisite:** the SERP snippet has to survive into the database. `worker.py`
was returning it from Apify and throwing it away; both the organic and PPC
mappings now keep `"description": (o.get("description") or o.get("snippet") or "")`.
The migration also backfilled 83,838 of 85,402 existing titles out of
`raw_results`, and rewrote `complete_scrape_job` to persist `serp_title` /
`serp_description`.

### Stage 1 — affiliate crawl (`7aa9f60`, `6823d99`)

`lib/ai-analysis/core.ts`, `run.ts`, `20260918140000_ai_website_analysis.sql`,
`app/api/ai-analysis/run/route.ts`

curl fetches the page, the model judges the content, and **code** extracts the
CTA links, unmasks cloaked redirects and attributes brands. That division is the
durable rule here — the model was unreliable at returning hrefs (10% accuracy on
a text fetch) and reliable at judging what a page is. ~$0.002/site.

Stores `ai_worth_checking`, `ai_is_affiliate`, `ai_brands`, `ai_cta_count`,
`ai_emails`, `ai_phones`, `ai_contact_page_url` on the profile, plus a
`website_cta_links` table. Hands off to the VM's existing browser s-tag stage.

**Two cleanup migrations you want to port with it** (`20260921100000`,
`…101000`): the first CTA counts were inflated ~25% by a cloak regex matching
content words like `/bonuses/`, payment/vendor links, and locale siblings of the
site itself. 800 links → 637 after narrowing `CTA_CLOAK`, adding
`NOISE_VENDOR_HOST`, and requiring a CTA to actually leave the site.

**Gotcha:** the API key is stored as `OPENAI_APIKEY` in the environment while
the production code reads `OPENAI_API_KEY`. Fix that on the way in.

---

## 3. A page per website — the lead drawer is gone

`app/(dashboard)/websites/**` (commits `7ddf9c2`, `16f3b48`, `eaaa65c`)

Clicking a domain used to open a 1,743-line drawer over the table, which meant
the page you were looking at was a lead row while the thing you were reading was
a website. Now `/websites/[domain]`. The drawer's body moved across intact
(affiliate detection, Rooster check, contacts, s-tags, owner network,
screenshots); the chrome — overlay, prev/next, close — went.

Layout, full width, in the order the question is asked:

1. **Header** — domain, AI description, counts, actions
2. **Verdict tiles** — already exists, on keyword, affiliate, Rooster, contacts, s-tags
3. **Appearances** — the per-row facts: keyword, country, position, device, batch
4. **Details** — the evidence, as cards flowing across two or three columns

Things that cost time to get right:

- **Appearances resolve by `profile_id`, not the lead's `domain` column.** That
  column stores the full origin (`https://www.example.com`), so matching a bare
  domain against it returns nothing. Every lead row has a profile id.
- Operator actions ("not relevant", force enrich, push) are **website-wide** —
  applied to every appearance and written onto the profile. A news site doesn't
  become relevant because a different keyword turned it up.
- Empty sections are **omitted**, not rendered as a column of `—`. The first
  version showed a stack trace as an "affiliate indicator"; long indicators now
  collapse to a summary you can open.
- The page splits into a cheap half (profile + appearances, two indexed
  queries) and an expensive half (contacts, s-tags, cohort RPC, signed URLs)
  behind `<Suspense>`. Both boundaries await the same `cache()`-wrapped loader.
  3.6s → 0.99s TTFB.
- `?from=` carries where Back should return to, honoured only for same-origin
  paths. Without it, it falls back to the batch of the newest appearance.

---

## 4. New-scrape wizard

`app/(dashboard)/scrape/new/**` (commits `32c5072`, `c35daa5`, `f1d17a9`,
`21b63cd`, and the 2026-09-21 layout run)

Replaces the inline create form on the batches page, which is now just a
"+ Scrape" button. Stepper on mobile, every input at once on desktop — both
render from the same `renderX(ans)` step bodies, branched on `matchMedia`.

Order matters and was corrected twice in review: **pages-per-keyword and device
sit after the keywords they apply to**, not above them. "Start from" (saved
configurations) is hidden when the user has none, and saved configs are
per-user. Submitting shows a queue ticket (`queue-ticket.tsx`); duplicate
keywords raise a **modal**, not a note below the fold, because nobody scrolled
to it.

---

## 5. Scrape list and batch view

- **Scope bar** (`scope-bar.tsx`): Today / Mine / All, defaulting to Today +
  Mine. Icon-only, no counts. Date picker and user picker are first-class
  filters, not hidden behind "+ add filter".
- **Advanced search** (`advanced-search.tsx`, `20260921140000_advanced_job_search.sql`):
  an extra-large modal with **its own filters**, deliberately independent of the
  page's. `pg_trgm` + GIN trigram indexes give partial matching — searching
  `jadalliya` finds `jadaliyya.com`. Fuzzy matching runs against
  `website_profiles.normalized_domain`, not the raw URL, because
  `https://www.jadaliyya.com` scores 0.26 against the query where
  `jadaliyya.com` scores 0.41.
- **Analysis summary** (`analysis-summary.tsx`, `20260921170000_job_analysis_summary.sql`):
  a strip above the batch table — relevance, where the websites already exist,
  how far enrichment got — counted over the whole batch rather than the visible
  page. Numbers that map to a real filter are links; the two that don't are
  plainly not.
- **Per-domain description column** and the single **"Already exists?"** badge
  replacing "Is on Monday?".
- **The counts have to add up** (`3b29d27`). The Results column read
  `organic_results` from the scrape summary — how many results the *search*
  returned — while the table renders *rows*. Nothing stopped it advertising "21
  results" over an empty batch. It now counts real rows, and the title
  reconciles the chain: *"21 results from the search · 2 same-site duplicates
  collapsed · 19 rows stored · 6 hidden as not relevant · 1 hidden by a system
  flag · 12 shown"*. The counts come from rows already fetched for the pipeline
  dots, so it costs no extra query. **Port this idea even if you port nothing
  else from this section** — a count derived from a different source than the
  thing it describes will drift again.

**In the SaaS version:** "Already exists?" collapses to **In system / New**.
Keep the precedence logic anyway — the reasoning is that scraping a site puts it
in the system by definition, so any external-source match outranks "in system",
and "in system" only means anything once the external source is ruled out. If
you later add a CRM integration, that slot is where it goes.

The "in system" test is `profile.first_seen_at < lead.created_at - 1 minute`.
The minute of slack stops rows within one batch marking each other as
pre-existing. Verified identical to an appearance-walking SQL function over 300
rows, so prefer the cheap version.

---

## 6. Performance

`d53cade`, `1b33909`

Measured before changing anything, and the database was never the problem: the
appearance query is 5ms, the cohort RPC 68ms, the Monday-candidate search 242ms.
The cost was serial round trips with nothing on screen.

- **`loading.tsx` on every dynamic page.** One of 28 had one. Without a loading
  boundary Next blocks the transition entirely — the old page stays frozen and
  nothing indicates the click registered. `app/(dashboard)/_components/page-skeleton.tsx`
  is a shared parameterised skeleton (`rows`, `stats`, `controls`).
- `experimental.staleTimes` for the router cache.
- Don't fetch what nobody sees: the appearances query was pulling 500 rows into
  a 560px scroll box. Now 100, with the true total reported from the profile.

Results: `/websites/[domain]` 3.6s → 0.56–0.99s, `/scrape/[id]` 1.62s → 0.68s,
everything else 1.0–2.1s → 0.59–0.73s (local dev; Vercel sits closer to the
database so absolute numbers are lower, but the shape holds).

---

## 7. Admin

- **`/admin/integrations`** (`32c5072`, `19e2dbf`): 11 services, live probes,
  in-app key entry, GoLogin drift detection, Google-login health.
- **`/admin/reports`** (`app/(dashboard)/admin/reports/**`): measurement reports.
- **`/admin/system`**: website-profile settings — dedupe toggle
  (`profile_dedupe_enabled`), verdict TTLs, recency bands.
- **`scripts/gologin/set-proxy-endpoint.ts`** (`2ad554d`): bulk-replaces the
  residential proxy endpoint across all GoLogin profiles. Dry-run by default.
  Relevant because the proxy lives *inside* the GoLogin profile, with the
  country encoded in the password — there's no single env var to change.

---

## 8. Small things that are easy to miss

- **Horizontal scroll with a sticky header.** A table that's `w-full` inside a
  `min-w-0` parent never overflows — extra columns squeeze the existing ones and
  there's nothing to scroll. Needs a `min-w-[…]` floor *and*
  `overflow-x-auto [overflow-y:clip]`. `clip` is the one value that doesn't
  promote the y-axis to a scroll container, so the page keeps owning vertical
  scroll and the sticky `<th>` stays pinned to the viewport.
- **Flags and brand icons**: `country-flag-icons/react/3x2` for SVG flags —
  Windows has no flag emoji glyphs. `react-icons/si` for sources; note there is
  **no Bing icon** in Simple Icons.
- **PostgREST `.or()` repeated is AND**, not OR. Bit us on the leads filter.
- **NULL propagation in SQL**: `p.is_not_relevant or f.board = 'x'` yields NULL
  when `board` is NULL, which then violates NOT NULL. `coalesce(…, false)` at
  every such site.
- Never serve reports or lead data from `public/`.

---

## Suggested porting order

1. The lead-domain functional index (§0) — three lines, prevents a timeout
2. Website profiles + the job-scoped dedupe fix (§1) — everything else sits on it
3. SERP snippet capture in `worker.py` + the title backfill (§2)
4. Relevance screen (§2) — cheapest, highest-signal win on its own
5. Accurate result counts (§5) — small, and prevents a whole class of bug
6. `loading.tsx` everywhere + the page skeleton (§6)
7. The website page (§3) — the largest single piece
8. New-scrape wizard (§4), admin pages (§7) — independent, do them whenever
9. The rest of §0 — the fallback, the scoring change, the timezone selector

Ask me for the exact diff on any section and I'll pull it.
