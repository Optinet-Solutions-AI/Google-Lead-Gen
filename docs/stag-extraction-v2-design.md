# S-tag extraction v2 — tiered design

> **Status:** design doc for Sprint 2 (2026-07-25 planning session). Ships nothing on its own; it exists so we can implement it deliberately.
> **Baseline (2026-07-24):** 15.9% extraction rate over the 30d window (see `scripts/qa/_stag-extraction-audit.ts` for the numbers-per-dimension breakdown).
> **Target:** 40%+ extraction rate by end of Sprint 2 — mostly by covering the current zero-success mass domains (gameshub / pokerfirma / betvictor / betway / royalpanda / casino.netbet.*).

## The problem

The current pipeline (`lib/stag-extraction/extract.ts`) is a single tier: walk the HTML → follow redirects → parse the final URL's query params. When any of those steps returns empty, the whole pipeline returns empty. Fifteen zero-success domains in our 30d data proves this fails often.

Failure modes we've observed:

| Symptom | Root cause | Tier that would catch it |
|---|---|---|
| URL param extraction returns nothing | Site tracks via cookies, not URL | **T2 (cookies)** |
| Redirect chain ends on operator's own domain with no `?...` | Site rewrites URL client-side after cookie drop | **T2 (cookies)** |
| Site uses network we don't recognize | Our param list is 5 wide, real world has ~15 networks | **T1 (per-network URL extraction, from `networks.ts`)** |
| Homepage has stale/no tracking, promo page has it | Landing page ≠ conversion page | **T3 (deep-link exploration)** |
| Site embeds affiliate ID in a JS variable / data-attribute | Not in URL, not in cookies, only in DOM | **T3 (DOM parse)** |
| Chromium blocked by captcha | Would need noVNC → already handled by the recovery pipeline | — |

## Architecture

```
              ┌───────────────────────────────────────────────┐
              │  Input: {url, country_code, lead_id}          │
              └────────────────────┬──────────────────────────┘
                                   │
              ┌────────────────────▼──────────────────────────┐
   TIER 0     │ CACHE LOOKUP                                  │
   ~1ms       │  stag_extraction_cache by root(url)           │
              │  if hit ∧ non-null ∧ younger than TTL → done  │
              └────────────────────┬──────────────────────────┘
                                   │ (miss / stale)
              ┌────────────────────▼──────────────────────────┐
   TIER 1     │ HTTP + REGEX                                  │
   50-500ms   │  curl-follow-redirects the URL                │
              │  parse final URL params via                   │
              │  networks.ts: networkForUrlParam(param)       │
              │  ALSO regex the HTML body for embedded IDs    │
              │  (some sites literally print the affiliate    │
              │  ID in a <script>window.__AFF_ID__="…"</script>) │
              │  Success → return                             │
              └────────────────────┬──────────────────────────┘
                                   │ (empty)
              ┌────────────────────▼──────────────────────────┐
   TIER 2     │ CHROMIUM COOKIE DROP                          │
   2-5s       │  headless Chromium (or reuse batch session    │
              │  from LGP-090)                                │
              │  driver.get(url)                              │
              │  wait for cookies to land (2s settle)         │
              │  driver.get_cookies() → networkForCookie(name)│
              │  Success → return                             │
              └────────────────────┬──────────────────────────┘
                                   │ (still empty)
              ┌────────────────────▼──────────────────────────┐
   TIER 3     │ DOM DEEP + DEEP-LINK EXPLORE                  │
   5-15s      │  Query DOM for [data-affid], footer badges,   │
              │  __NEXT_DATA__ / __NUXT__ / window.__STATE__  │
              │  scan for affiliate patterns                  │
              │  if still empty → follow /join, /signup,      │
              │  /promo, /bonus links (LGP-092 shape) and     │
              │  re-run TIERS 1-2 on each                     │
              └────────────────────┬──────────────────────────┘
                                   │
              ┌────────────────────▼──────────────────────────┐
              │ WRITE:                                        │
              │   s_tags_table (s_tag, network, extracted_via,│
              │     tier, tracking_url, final_url, ms_total)  │
              │   stag_extraction_cache (upsert domain →      │
              │     result + tier + timestamp)                │
              └───────────────────────────────────────────────┘
```

## Instrumentation

Every extraction writes back to `s_tags_table` with these fields (existing schema already has `extracted_via`, we widen its meaning):

- `extracted_via`: `t0_cache | t1_url_param | t1_html_regex | t2_cookie | t3_dom | t3_deeplink`
- `network`: one of the `networks.ts` keys (`cellxpert / income_access / …`) or `null`
- `ms_total`: total wall-clock ms for the extraction chain

This lets us re-run `_stag-extraction-audit.ts` and see:
- Which tier is doing the work? (Aim: 60%+ in T1, 30% in T2, 10% in T3)
- Which network dominates? (Reveals which affiliate programs the vertical is really running on)
- How many tries per domain? (Cache hit rate as `t0_cache` share)

## Interfaces (TypeScript)

```ts
// lib/stag-extraction/pipeline-v2.ts
export type StagExtractionResult = {
  s_tag: string | null
  network: string | null
  tier: 't0_cache' | 't1_url_param' | 't1_html_regex' | 't2_cookie' | 't3_dom' | 't3_deeplink' | null
  ms_total: number
  tracking_url: string | null
  final_url: string | null
  cookies_seen?: number
  html_length?: number
}

export async function extractStagV2(
  url: string,
  opts: { country_code?: string; lead_id?: number; skip_cache?: boolean } = {},
): Promise<StagExtractionResult>
```

`extractStagV2` is the single entry point that scoring / enrichment code calls. Each tier is a small module (`tier1-http.ts`, `tier2-cookie.ts`, `tier3-dom.ts`) so tests can unit-test them in isolation and future tiers can be added without touching the dispatch.

## Non-goals for this design

Explicitly deferred so we can ship v2 without scope creep:

- **Screenshot OCR** — some sites only render the affiliate ID as an image in the footer. Ignore until v3 unless it turns out to matter for >5% of unmapped domains.
- **DNS/TXT record scraping** — theoretically some networks embed partner IDs there; no evidence we need it.
- **Prediction model** — could learn "for this domain, try this extractor first". Overkill for baseline improvement; revisit only if T1/T2 tiers are correct >90% of the time and we just want to reduce latency.

## Ship order (subject to LGP-094 memo)

1. Wire up `networks.ts` into the current single-tier extractor. Zero risk; just widens the param set. **Expected lift: +10-15pp on domains that use non-btag/stag networks.** (v0)
2. Add `stag_extraction_cache` table + T0 lookup. **Expected: -50% Chromium spins on mirror-group domains.** No accuracy impact.
3. Add T2 cookie tier. **Expected lift: +10-20pp on operator sites that use cookie-only tracking.** Highest risk, highest reward.
4. Add T3 DOM tier + deep-link explore (LGP-092 findings inform whether this is worth it). **Expected: +5pp, small marginal impact.**
5. Add domain-batched execution (LGP-090). Latency + cost win, not accuracy.
