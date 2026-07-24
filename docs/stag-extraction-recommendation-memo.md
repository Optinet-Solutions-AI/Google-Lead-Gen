# S-tag extraction optimization — ranked memo + Sprint 2 build order

**Date:** 2026-07-24
**Owner:** Christian
**Baseline:** 15.9% extraction success on the 30-day window (262 of 1,648 attempts).
**Target:** 40% by end of Sprint 2. That's a 24pp lift, ~2.5× more S-tags flowing into Monday.

## TL;DR

Ship interventions in this order:

| # | Intervention | Est effort | Est lift | Cumulative rate |
|---|---|---:|---:|---:|
| 1 | **Widen the URL-param list via `networks.ts`** | XS (½ day) | **+10-15pp** | ~28% |
| 2 | **Cookie-tier (T2) using the same `networks.ts` catalog** | M (2-3 days) | **+10-20pp** | ~40% |
| 3 | **`stag_extraction_cache` (T0)** | S (1 day) | 0pp accuracy, **-40% Chromium cost** | 40% at ~60% of previous cost |
| 4 | **Domain batching** | M (1-2 days) | 0pp accuracy, **5× throughput on same-domain clusters** | 40% at ~30% of original cost |
| 5 | **Deep-link explore (T3)** | S (1 day, `deep-link-candidates.ts` shipped) | **+3-5pp** | ~45% |
| 6 | **DOM-DEEP parse (T3 fallback)** | M (2 days) | **+2-3pp** | ~47% |

Interventions 1-3 unlock the big lift AND the cost reduction that funds the more expensive Sprint-3 work. Ship 1 solo; ship 2+3 together; ship 4 once we have baseline throughput numbers post-3.

---

## Evidence base

### What the baseline audit told us (scripts/qa/_stag-extraction-audit.ts)

- **Overall: 15.9%.** Confirmed the memo's premise that this is worth fixing.
- **Country spread: 3.3% (AT) → 29.6% (AE).** AT is the single biggest failure — 241 attempts, only 8 successes. Not a country issue per se; the AT operators cluster on affiliate networks we don't recognize.
- **Domain concentration:** 15 zero-success domains account for ~30% of the failure tail. `gameshub.com` alone: 0/65. These are content aggregators using non-btag/stag tracking.
- **Winning params today:** `btag` (24%) > `stag` (13%) > `cxd` (8%) > `mid` (5%) > `affid` (4%). Total: 54%. **That means 46% of our current successes come via a code path we haven't instrumented.** Either the data quality on `extracted_via` is off, or there's more variety already sneaking through — either way a full T1 rewrite is safe.

### Why cookies matter (LGP-087 POC design)

Cookies are the ground truth of what the affiliate network attributes the click to. URL params can drop off during redirects; a cookie survives. The POC (`vm/stag_cookie_poc.py`) is ready to run against the 25-URL candidate list (`vm/candidate_urls.txt`, split 5 validation / 20 discovery). Once it runs on a VM tomorrow, we'll know:

- **How many of the 5 known-good sites reproduce their expected s_tag from cookies?** ≥ 4/5 = green-light the T2 tier build. ≤ 2/5 = the cookie names we're checking are wrong; iterate on `networks.ts`.
- **How many of the 20 unmapped sites drop an affiliate-signature cookie the URL never carried?** That's the direct measurement of T2's lift ceiling. If it's ≥ 8/20, cookies alone move the needle to 30%+ overall.

The POC script deletes cookies between URLs so per-URL attribution is clean. It logs cookie count, matched-network count, URL-param comparison, and load timing per URL.

### Why the per-network catalog matters (LGP-088)

The current `STAG_PARAM_ORDER` in `lib/stag-extraction/extract.ts` is 5 params wide: `btag`, `stag`, `cxd`, `mid`, `affid`. The just-shipped `lib/stag-extraction/networks.ts` covers **~35 distinct URL params + ~40 cookie names across 13 networks.** Even before we build T2, if we route the T1 URL-param check through `networkForUrlParam()` we should pick up nickel-and-dime lift from `irclickid` (Impact), `iaID` (Income Access), `a_aid` (Post Affiliate Pro), `ef_click` (Everflow), etc. — none of which we currently recognize.

**This is intervention #1** and it's stupid-cheap: replace the `STAG_PARAM_ORDER` loop with a `for network of AFFILIATE_NETWORKS: for param of network.urlParams` loop. Two-line change.

### Why deep-link exploration matters (LGP-092, but only later)

`lib/stag-extraction/deep-link-candidates.ts` finds conversion-page CTAs on any HTML (verified on synthetic input in `scripts/qa/_test-deep-link-finder.ts`). But **deep-link exploration is a cost multiplier** — each candidate means another Chromium session against T1/T2. Only worth it if T1 and T2 have failed on the primary URL. That puts it firmly in T3 territory and behind interventions 1-4.

---

## Sprint 2 acceptance criteria

Every intervention we ship must:

1. **Bump the `_stag-extraction-audit.ts` overall-rate number by at least the target lift** on the same 30d window. Baseline is recorded in the audit script's header comment; each intervention writes its post-ship number below it.
2. **Instrument `extracted_via` correctly.** New `t0_cache | t1_url_param | t1_html_regex | t2_cookie | t3_dom | t3_deeplink` values. Backfill `extracted_via = 'legacy'` on old rows so cardinality stays honest.
3. **Ship a rollback plan.** Every tier is behind a `system_settings.stag_extraction_v2_enabled` boolean the on-call can flip if the extraction rate cratered instead of climbing.
4. **PMS entry:** each intervention gets its own `[LGP-###]` when the work starts, dated the day it ships.

---

## What's NOT in Sprint 2

Explicit non-goals so scope doesn't drift:

- **Screenshot OCR** — some footers only show the affiliate ID as an image. Ignore unless the T1+T2 combo leaves us with a stubborn 30%+ tail of otherwise-unexplained failures.
- **Prediction model** ("for this domain, try Everflow first") — overkill until T1/T2 are correct. Save for Sprint 4+.
- **DNS TXT record scraping / referral-program APIs** — no evidence these help our vertical.
- **Rewriting the `extract.ts` legacy path** — leave alongside v2 during a rollout window; delete once v2 has been stable for 14+ days at higher rate.

---

## Handoff for tomorrow (2026-07-25)

Everything below is ready for a fresh eye:

- `scripts/qa/_stag-extraction-audit.ts` — re-runnable baseline (defaults 30d)
- `lib/stag-extraction/networks.ts` — 13-network catalog with URL + cookie signatures
- `lib/stag-extraction/deep-link-candidates.ts` — conversion-page finder + `scripts/qa/_test-deep-link-finder.ts` smoke test
- `docs/stag-extraction-v2-design.md` — tiered pipeline architecture
- `docs/stag-extraction-batching-and-cache.md` — LGP-090 / LGP-091 detail
- `vm/stag_cookie_poc.py` + `vm/candidate_urls.txt` — POC script + 5-validation-plus-20-discovery URL input, ready to run on either VM
- `docs/stag-extraction-recommendation-memo.md` — this file

**Priority 1 for the morning:** run the POC on VM1, publish the results as a comment on `[LGP-087]`. That single data point decides whether intervention #2 (T2 cookies) stays as-scoped or grows.
