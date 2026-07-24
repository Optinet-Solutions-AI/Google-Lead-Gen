# S-tag extraction: batching + caching design

Companion to [`stag-extraction-v2-design.md`](./stag-extraction-v2-design.md). Two orthogonal wins on top of the tiered pipeline:

1. **Domain batching** — reuse one Chromium session across N URLs on the same domain instead of cold-starting N sessions.
2. **Cache-and-skip** — remember what worked on each domain and skip re-extraction for a TTL window.

Neither improves *accuracy*, but both cut *cost* and *latency* dramatically, which matters because Chromium startup is the current dominant cost.

---

## [LGP-090] Domain batching

### The waste we're removing

Current path (per URL, worst case):

```
per URL:  spawn Chromium (2-4s) → warm proxy (0.5s) → navigate (0.5s) →
          settle (2s) → close (0.5s)   ≈ 5-8s total
                     ↑
                cost we pay once per URL, even for URLs on the same site
```

Batched path (per DOMAIN):

```
per domain, N URLs:
          spawn Chromium (2-4s) → warm proxy (0.5s) →
          for URL in urls_on_this_domain:
              driver.get(url) (0.5s) → settle (1s) → capture cookies (0.02s)
          close (0.5s)
                     ↑
                fixed startup cost amortized over N URLs
```

Expected wall-clock for a 10-URL batch on one domain: **~12s vs ~60s** (5× faster). At current 50-200 URLs/hour Chromium extraction throughput per bot, this recovers ~30 minutes of bot time daily fleet-wide even at modest batch sizes.

### Implementation shape

Extend the extractor queue with a batch-forming step:

```
class ExtractionRunner:
    def take_batch(self, max_urls: int = 10) -> list[LeadCandidate]:
        # SQL: SELECT ... FROM lead_candidates
        #      WHERE root_domain = (
        #          SELECT root_domain FROM lead_candidates
        #          WHERE claimed_by IS NULL
        #          ORDER BY priority DESC, created_at
        #          LIMIT 1
        #      )
        #      AND claimed_by IS NULL
        #      LIMIT max_urls
        # Atomic UPDATE-then-return so multiple bots don't race on the
        # same domain. active_profile_locks-shaped: lock by root_domain
        # rather than country.
        ...

    def process_batch(self, batch: list[LeadCandidate]):
        with self.chromium_session() as driver:
            for lead in batch:
                # Cookies from lead N leak into lead N+1 -- that's fine
                # for same-domain URLs (they SHOULD share affiliate
                # tracking) but bad if the domain differs.
                # Batch is guaranteed same-domain by take_batch above.
                extraction = self.extract_via_current_tier(driver, lead)
                self.write_back(lead, extraction)
```

### Non-obvious risks

- **Session fingerprinting**: sites that rate-limit by cookie-jar age or by "how many pages did this session view" may flag batches larger than ~5-10. Mitigation: cap `max_urls` at 10 per session; open a fresh session per batch.
- **Cookie contamination**: same-domain cookies from URL N pollute URL N+1's extraction. For same-domain batches this is a *feature* (same operator = same affiliate ID). For deep-link exploration (LGP-092) it means we should delete cookies between the landing page and the /join page probe if we want per-page attribution.
- **Proxy sticky vs rotating**: batches share an IP. That's fine — better than the current per-URL IP churn — but check that sticky-proxy countries (DE, GB, NO from `gologin_profiles`) don't get *stuck* on a bad IP if the batch is unlucky. Solution: if 3+ URLs in a batch fail with the same error, break the batch and rotate proxy for the remainder.

### Sizing

Start with `max_urls=5`. Instrument success rate, wall-clock per batch, per-URL rate. If success rate stays flat while wall-clock stays proportional to batch size (i.e. no per-URL cost inflation), bump to 10. Never above 15 without evidence — the fingerprinting risk grows non-linearly.

---

## [LGP-091] Cache-and-skip

### The waste we're removing

The scrape flow re-extracts the S-tag every time a lead-URL is scored, even when we already extracted from the same domain a week ago and the affiliate program almost certainly hasn't rotated. On mirror-group domains where 5 leads land on `casino-review.com`, we currently extract 5 times.

### Schema

```sql
create table public.stag_extraction_cache (
  root_domain      text primary key,
  last_s_tag       text,        -- may be null if the last attempt was empty
  last_network     text,        -- e.g. 'cellxpert' or NULL
  last_tier        text,        -- 't1_url_param' | 't2_cookie' | ...
  last_extracted_at timestamptz not null default now(),
  extraction_count int not null default 1,
  -- Rolling counters for the memo work later.
  success_count    int not null default 0,
  empty_count      int not null default 0,
  -- Populated when a network signature was *found* but we're
  -- unsure of the exact affiliate id — helps operators triage.
  detected_network text
);

create index stag_extraction_cache_last_extracted_at
  on public.stag_extraction_cache (last_extracted_at);
```

### TTL rules

Two-band TTL — non-null results cache longer than nulls:

- **Success (last_s_tag is not null):** TTL = 7 days by default, tuneable per-network. Cellxpert / MyAffiliates rarely rotate; DIY / small networks rotate more. Store per-network TTL override in `system_settings`.
- **Empty (last_s_tag is null):** TTL = 12 hours. If we tried and got nothing yesterday, don't retry today. Bump to a full retry when we ship a new extractor version.

### Ship logic

```ts
async function extractStagV2(url: string, opts) {
  const domain = rootDomain(url)
  if (!opts.skip_cache) {
    const cached = await cacheLookup(domain)
    if (cached && !cacheStale(cached)) {
      return { ...cached, tier: 't0_cache' }  // instant
    }
  }
  const result = await runTiersInOrder(url, opts)  // T1 → T2 → T3
  await cacheWrite(domain, result)
  return result
}
```

### Estimated savings

From the audit data (2026-07-24 baseline):

- 1,648 attempts in 30d = ~55/day
- Top 20 domains account for ~40% of attempts (rough eyeball from `_stag-extraction-audit.ts` output)
- Assume 7-day cache hit rate on those top domains ~70% → **~15 Chromium sessions/day saved** (28% reduction on top-domain traffic)
- At current tier costs, that's ~30 min/day of Chromium wall-clock recovered fleet-wide

Not the highest-impact intervention on accuracy (that's cookies), but easy shipping win on infra load.

### Cache-bust triggers

Even inside the TTL, bust the cache when:

1. **Operator explicitly requeues** (`scrape_queue.rerun_specific`) — obvious.
2. **New extractor version deploys** — write a `stag_extractor_version` int to `system_settings`; the cache stores the version at extraction time; a mismatch busts.
3. **Domain has 3+ consecutive `is_on_monday` mismatches** — signal that the affiliate ID has actually rotated at the source.

---

## Sequencing (both features)

Cache-and-skip is trivial to build (single table + read/write) and unlocks the batching work (batches can safely skip cache-hit URLs so they're all fresh queries). Do cache-and-skip first.

**Ship order:**
1. Cache-and-skip migration + T0 layer in `pipeline-v2.ts` (~half-day)
2. Domain-batched extractor runner (~1-2 days, more invasive)
3. Instrument both — dashboard on Operations showing "cache hit rate" and "avg URLs per Chromium session" once landed
