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
- **Source of truth (current default).** Monday wins: if the matched item has a
  datum, we inherit it labeled `monday`. Our own extraction still fills gaps
  Monday doesn't cover. (The finer skip-policy + conflict rules are LGP-224/226,
  left open pending a product decision.)
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

## Open (pending product decision)
- **LGP-224** — per-stage skip: enrich only the stages Monday couldn't fill.
- **LGP-226** — source-of-truth conflict handling when both Monday and system
  have data (default today: Monday wins, system fills gaps).
