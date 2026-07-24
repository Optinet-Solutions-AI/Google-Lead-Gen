# S-tag extraction — additional research findings

**Companion to** `docs/stag-extraction-recommendation-memo.md`.
**Date:** 2026-07-24 (afternoon session, after the morning memo shipped).
**TL;DR:** The morning memo focused on WHICH tag we extract. Follow-on forensics on the failure domains reveals the primary problem is actually WHETHER WE GET ANY HTML AT ALL. The recommendation order below reflects that pivot.

## The pivot

Morning memo assumed the failure mode was "we fetched HTML but couldn't find the tag." The forensic dig (`scripts/qa/_stag-failure-forensics.ts` + `_check-html-tags-population.ts`) shows the actual failure mode is different:

- **`html_tags` is NULL on every sampled lead** (1,000/1,000 in the 30d window). The captured-HTML column exists on `google_lead_gen_table` but the pipeline never writes to it.
- **The fetcher is `lib/affiliate-detection/fetch.ts` `fetchHtml()`** — plain `fetch()` with browser-ish headers. No JavaScript execution. No cookie jar. No residential proxy. No Cloudflare handling.
- **Its own doc comment says:** *"Many casino-affiliate sites are behind Cloudflare and will return 403/503 to us — those rows simply get classified with confidence ERROR."*

The consequence: every modern React/Next SPA (gameshub.com, casinobeats.com, cardplayer.com, betvictor.com, betway.com, royalpanda.com, casino.netbet.com...) returns effectively-empty HTML. There is no tag to extract because the page has no content until JS runs. Fixing THIS is a bigger single lever than every network+cookie intervention combined.

Baseline shifts:

| Statement | Before | After forensics |
|---|---|---|
| Overall extraction rate | 15.9% | 15.9% (same) |
| Root cause of ~70% of failures | "affiliate tracking format we don't recognize" | **"page never rendered — we got empty HTML back"** |
| Highest-impact single fix | Widen networks catalog into T1 | **Server-side JavaScript rendering (Playwright on the VM)** |

## Updated ranked interventions

Cost/lift estimates refreshed with the new understanding. **JavaScript rendering jumps to #1** because it unblocks *every* other tier — cookies, DOM parse, deep-link — none of which do anything if the page never rendered.

| # | Intervention | Effort | Expected lift | Notes |
|---|---|---:|---:|---|
| 1 | **Server-side JavaScript rendering** (Playwright on VM, replace `fetchHtml`) | L (3-4d) | **+20-30pp** | Unblocks every downstream tier. Reuses existing VM Chromium/GoLogin infra. |
| 2 | **Widen T1 via `networks.ts` catalog** (already shipped as library) | XS (½d) | **+5-10pp on the leads where fetch WAS working** | Free win once #1 lands. |
| 3 | **Cookie tier T2** | M (2-3d) | **+10-15pp** | Depends on #1 landing. |
| 4 | **`__NEXT_DATA__` / SSR state parse** | S (1d) | **+3-5pp** | Modern sites bake their affiliate state into `<script type="application/json">`. Trivially greppable once we have the HTML. |
| 5 | **`stag_extraction_cache` (T0)** | S (1d) | 0pp accuracy, **-40% cost** | Independent of the fetch stack. |
| 6 | **Cookie consent + age-gate auto-click** | M (1-2d) | **+5-10pp on EU/casino sites** | Only meaningful once #1 lands and we have Playwright. |
| 7 | **Network request interception** (capture 3rd-party tracker calls during load) | M (2d) | **+5-8pp** | Reveals cookies+URLs that never touched the visible URL. |
| 8 | **localStorage / sessionStorage capture** | XS (½d) | **+2-4pp** | Small win, tiny effort. Bundle with T2. |
| 9 | **Domain batching** | M (1-2d) | 0pp accuracy, **5× throughput** | Higher priority once #1 lands (Playwright startup is more expensive than plain fetch). |
| 10 | **Residential proxy for the fetch** | S-M (1-2d) | **+3-5pp** on geo-gated sites | Route Playwright through Enigma. |
| 11 | **Deep-link explore (T3)** | S (1d) | **+3-5pp** | Only after 1-3. |
| 12 | **DOM-DEEP parse (T3)** | M (2d) | **+2-3pp** | Only after 1-3. |
| 13 | **AI/LLM fallback for the tail** | M-L | **+2-5pp** on the stubborn ~10% | Pay-per-call; last resort. |
| 14 | **Human-in-the-loop for the stubborn tail** | M | **+2pp** | Same shape as the captcha reviewer pool. |
| 15 | **Sitemap.xml crawl for deep discovery** | S | **+1-3pp** | Some sites list all conversion pages in sitemap. |

## Additional research ideas beyond the ranked list

Kept for reference; either lower expected lift, higher risk, or explicit non-goals.

### Worth investigating in Sprint 3+

- **Session-warmup pattern** — visit the homepage FIRST (setting cookies), then hit the affiliate CTA. Some networks gate tag exposure on session state. Bundle with #6 auto-click.
- **User-agent rotation** — some sites gate content by mobile vs desktop. Cheap to try but only after Playwright is in.
- **CSP report-uri capture** — a small subset of sites leak tracking pixel URLs via CSP reports. Niche.
- **Referer-based extraction** — visit the operator with a Referer: <review-site> header. Sometimes drops different (fresher) cookies. Bundle with #7.
- **`<meta>` + Schema.org structured data** — some sites embed affiliate IDs in `<meta property="og:...">` or JSON-LD. Free once the HTML is rendered.
- **Prior-belief cache from historical data** — if this domain resolved to Cellxpert-9876 six months ago and the domain hasn't changed hands, use that as a fallback. Guardrails on rotation detection.

### Deferred to Sprint 4+ (or dropped)

- **Screenshot OCR** — retained as non-goal from morning memo. Tail case only.
- **DNS TXT record scraping** — no evidence of value.
- **WHOIS enrichment** — mostly noise.
- **Reverse image search on operator logos** — overkill.
- **Wayback Machine lookup** — interesting for research but not a scalable extractor.
- **Community intel exchange / paid tag DBs** — cost-uncertain.
- **Google search "site:x affiliate id"** — brittle, blocked, would need SERP scraping.
- **Postback / server-side conversion tracking rev-eng** — high effort, low sample yield.

## What we're literally NOT doing today that we could

Beyond "extract better" — some of these adjacent ideas came up during research:

1. **Detect + mark the "empty HTML" failure explicitly** — right now these leads go into the same `has_s_tags=false` bucket as "we got HTML but no tag". Splitting them lets us track the fetch-fail rate separately and route "fetch failed" leads to the retry-with-Playwright path instead of counting them as "unmapped, tried, nothing there."
2. **Instrument the fetch failure reason** — `fetchHtml` already returns a rich error string. Persist it as `s_tag_check_error` on the lead row so we can query "how many failed because of Cloudflare 403 specifically?" and target that failure mode.
3. **Retry after N hours on empty-HTML failure** — pages sometimes go down transiently. Zero-cost win.
4. **Multi-URL fanout on ambiguous leads** — some SERP results are aggregator pages listing 10 casinos. Extract tag PER outbound tracker, not just one per lead.

## Handoff — what to build first

Given the pivot, tomorrow's priority reorders to:

**Priority 1:** Instrument the current fetch layer to distinguish "fetch succeeded but no tag" from "fetch failed / empty body". No code change needed to the extractor — just record `fetch_ok`, `fetch_status`, `fetch_error` on the lead row. Re-run the audit. If ~70% of "failures" are actually fetch-failures (as the forensics implies), we lock in the JS-rendering thesis before spending 4 days on it.

**Priority 2:** Run the cookie POC on VM1 as originally scheduled. Its results still matter for tier ordering, and running it on VM1 is free once the box is available.

**Priority 3:** Playwright-based `fetchHtml` v2 on VM, replacing the plain-fetch version for the leads that failed the first pass. Ship behind a feature flag; instrument tier attribution; re-run audit.
