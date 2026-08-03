# Monday source labeling & inheritance (Contact-extraction v3, LGP-210–239)

When a scraped lead matches a Monday.com item, we **inherit** that item's data
into our own tables — contacts, s-tags, and affiliate/rooster classification —
**labeled as Monday-sourced**, instead of re-extracting it. This fills the ~34k
leads that were on Monday but sat blank locally, and lets enrichment skip paid
browser work it doesn't need.

## The model

- **Provenance labels.** Every inherited datum is tagged so operators can tell
  it apart from our own extraction:
  - `contact_table.source = 'monday'` and each `items[].method = 'monday'`
  - `s_tags_table.origin = 'monday'`
  - `google_lead_gen_table.affiliate_source / rooster_source = 'monday'`,
    plus `monday_inherited_at`
- **Per-stage skip (LGP-224).** On-Monday leads now flow through enrichment,
  but each stage is skipped per-lead only when Monday satisfied it (its
  `*_checked_at` is stamped by inheritance). The stages Monday couldn't fill —
  e.g. a leads-board item's affiliate check, an item with no email's contact
  extraction, an affiliate with no brand columns' s-tags — run normally. This
  fills the gaps while still skipping everything Monday already knew.
- **Source of truth (LGP-226).** Monday wins: if the matched item has a datum,
  we inherit it labeled `monday` and skip that stage. To replace Monday-sourced
  data with a fresh system extraction, the operator **force-enriches**
  (regenerate is an explicit user action) — that clears the `*_checked_at`
  stamps and re-runs the stages, overwriting the `monday` labels with system
  ones.
- **What comes from where** (Affiliates board):
  - `email` → email contact; `website` → contact link
  - brand tracking-id columns `l7_sj_rs_lv_ro` (Lucky7Even/SpinJo/RocketSpin/
    LuckyVibe/Rollero), `rb_fp_su` (Rooster.bet/FortunePlay/SpinsUp), `pm`
    (PlayMojo), `nd` (NovaDreams) → s-tags + Rooster-partner + brand
  - affiliates-board membership → `is_affiliate = true`

## How it runs

- **`get_monday_item_for_lead(lead_id)`** — reads the matched replica row from
  the right board table.
- **`inherit_monday_data_for_lead(lead_id)`** — normalizes + writes everything,
  labeled `monday`, and sets `has_contact_details` / `has_s_tags` /
  `*_checked_at` so the enrichment skip gate treats those stages as satisfied.
  Idempotent (dedup-guarded s-tag inserts, `coalesce` flags, stamps
  `monday_inherited_at`).
- **`inherit_monday_data_batch(limit)`** — inherits for un-inherited on-Monday
  leads. A **pg_cron job (`inherit-monday-data`, every 5 min)** calls it so
  newly matched leads inherit automatically.
- Reference normalizers live in `lib/monday/inherit.ts` (unit-tested); the SQL
  RPC mirrors them.

## Runbook

**Force a fresh re-extraction of a Monday-sourced lead**
Use the drawer's Force-enrich button or `force_enrich_leads([id])`. It sets
`force_enrich = true` (overrides the `is_on_monday` skip) and clears the
`*_checked_at` timestamps, so the chain re-enqueues and our extraction
overwrites the `monday`-labeled contacts with freshly-labeled system data.

**Re-run inheritance manually** (e.g. after a Monday sync backfills columns)
```
npx tsx scripts/qa/_monday-inherit-backfill.ts        # all un-inherited on-Monday leads
# or a single lead, in SQL:  select inherit_monday_data_for_lead(<lead_id>);
```
Re-running is safe (idempotent). To force a lead to be re-considered by the
batch/cron, null its `monday_inherited_at`.

**Audit source labels / measure savings**
```
npm run qa:monday-inherit-probe          # coverage lift + enrichment jobs avoided
npm run qa:test-monday-integration       # DB-level correctness assertions
npm run qa:test-monday-inherit           # pure-unit normalizer tests
```

**Check the auto tick**
```
select * from cron.job where jobname = 'inherit-monday-data';
```

## Migrations
- `20260803120000_monday_source_labeling.sql` — labels + `get_monday_item_for_lead`
- `20260803130000_monday_inheritance_rpc.sql` — `inherit_monday_data_for_lead` / `_batch`
- `20260803140000_monday_inherit_cron.sql` — the 5-minute tick
- `20260803150000_monday_perstage_skip.sql` — per-stage skip (LGP-224): inherit
  stamps `affiliate_checked_at`/`rooster_checked_at`; the chain lets inherited
  leads through so only Monday's gap-stages enqueue.

## Note on existing gaps
The per-stage gap-filling applies to scrape jobs going forward. Leads already
inherited whose jobs are `complete` (with an affiliate/contact/s-tag gap Monday
couldn't fill — ~5.2k / 2.2k / 1.9k respectively) won't retroactively re-enrich;
force-enrich them to fill the gaps on demand (kept manual on purpose while
2captcha/enrichment throughput is constrained).
