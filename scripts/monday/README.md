# Monday.com → Supabase sync

Two scripts for one-time data export from 4 Monday boards into Supabase replica tables.

## Prereqs

In `.env.local`:

```
MONDAY_API_TOKEN=<personal token from Profile → Developers → My Access Tokens>
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

## 1. Discovery (already run)

```bash
npm run monday:discover
```

Enumerates the 4 target boards, dumps their column schemas + sample items to `scripts/monday/output/schemas.json` (gitignored).

## 2. Apply the migration

The migration `supabase/migrations/20260423120000_monday_replica_tables.sql` creates 8 tables (4 boards × 2):

- `leads_table`, `leads_updates_table`
- `affiliates_table`, `affiliates_updates_table`
- `not_relevant_leads_table`, `not_relevant_leads_updates_table`
- `email_undelivered_leads_table`, `email_undelivered_leads_updates_table`

Apply one of two ways:

**Option A — Supabase Dashboard:** SQL Editor → paste the file contents → Run.

**Option B — Supabase CLI:**
```bash
supabase link --project-ref veqfloktkejmyueskltp
supabase db push
```

## 3. Sync

```bash
npm run monday:sync
```

Walks every item on every board, upserts to the matching `_table` + every `updates` to the matching `_updates_table`. Safe to re-run (upserts on `monday_item_id` / `monday_update_id`).

**Expected runtime:** ~15–25 min for ~13,000 items + their updates at 25 items/page and a 700 ms throttle. Progress is logged per page.

## Board → table mapping

| Monday board | Board ID | SQL items table | SQL updates table | Monday columns |
|---|---|---|---|---|
| Leads | 1236073873 | `leads_table` | `leads_updates_table` | 13 |
| Affiliates | 1237788929 | `affiliates_table` | `affiliates_updates_table` | 18 |
| Not Relevant Leads | 1237789472 | `not_relevant_leads_table` | `not_relevant_leads_updates_table` | 16 |
| Email Undelivered Leads | 1237006289 | `email_undelivered_leads_table` | `email_undelivered_leads_updates_table` | 16 |

## Known limits

- **Updates are fetched inline (100 per item, per page).** Items with >100 updates will only have their first 100 synced. Acceptable for initial load; a follow-up script can paginate further per item if needed.
- **Monday files/subitems are not recursively fetched.** The `files` column stores Monday's asset JSON as text; `subitems_count` is the count only — not the subitem rows themselves.
- **Column values are stored as `text`.** Monday's `text` display value is kept in typed SQL columns (keywords, status, etc.); the full shape lives in `raw_column_values` jsonb for re-processing.
