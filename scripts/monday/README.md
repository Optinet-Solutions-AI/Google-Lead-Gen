# Monday.com ↔ Supabase

Two layers:

- **Bulk sync** — one-time (or on-demand) full export of all items + updates.
- **Real-time webhooks** — Monday pushes every item/update change to our Next.js API route; the handler upserts to Supabase in ~1–3 seconds.

## Env vars (`.env.local`)

```
MONDAY_API_TOKEN=<personal token — Profile → Developers → My Access Tokens>
MONDAY_SIGNING_SECRET=<Monday app signing secret — used to verify webhook JWTs>
MONDAY_APP_ID=<Monday app ID — optional pin for webhook verification>
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

---

## Bulk sync (first-time load)

### 1. Discovery

```bash
npm run monday:discover
```

Enumerates the 4 target boards and dumps their column schemas to `scripts/monday/output/schemas.json` (gitignored).

### 2. Apply the migration

`supabase/migrations/20260423120000_monday_replica_tables.sql` creates 8 tables (4 boards × 2).

- **Dashboard:** https://supabase.com/dashboard/project/veqfloktkejmyueskltp/sql/new → paste the migration → Run.
- **CLI:** `supabase link --project-ref veqfloktkejmyueskltp && supabase db push`

### 3. Run the sync

```bash
npm run monday:sync
```

~15–25 min for ~13,000 items + updates at 25 items/page, 700 ms throttle. Idempotent — safe to re-run.

---

## Real-time webhooks

Endpoint: `POST /api/monday/webhook` (at [app/api/monday/webhook/route.ts](../../app/api/monday/webhook/route.ts))

Handles two request shapes:

1. **Challenge handshake** (during `create_webhook` registration) — echoes the `challenge` field back with 200.
2. **Event delivery** — verifies the JWT in the `Authorization` header using `MONDAY_SIGNING_SECRET`, then dispatches to the matching handler.

Events subscribed to on every board:

| Event | Action |
|---|---|
| `create_item`, `change_column_value`, `change_name` | Fetch item via GraphQL, upsert into `{board}_table` |
| `item_deleted`, `item_archived` | DELETE from `{board}_table` + its updates |
| `create_update`, `edit_update` | Fetch update via GraphQL, upsert into `{board}_updates_table` |
| `delete_update` | DELETE from `{board}_updates_table` |

Events for boards not in `lib/monday/board-registry.ts` are ignored (returns 200) so Monday doesn't retry.

### Deployment prerequisites

- Next.js app deployed to a publicly reachable HTTPS URL (e.g. `https://yourapp.vercel.app`). For local testing: `ngrok http 3000`.
- `MONDAY_SIGNING_SECRET` set in the deployment's env (Vercel → Project Settings → Environment Variables).

### Register the webhooks

Once deployed (or ngrok'd):

```bash
npm run monday:register-webhooks -- --url https://yourapp.vercel.app/api/monday/webhook
```

Registers 4 boards × 8 events = **32 webhooks**. Skips any webhook already registered for the same `(board, event, url)` triple.

Monday does a challenge handshake during registration; our route handler responds correctly, so no extra setup is needed. If the handshake fails (wrong URL, HTTP instead of HTTPS, app not deployed yet), `create_webhook` returns an error and the script logs it.

### List current webhooks

```bash
npm run monday:list-webhooks
```

Shows every webhook on the 4 target boards with its ID, event type, and target URL.

### Unregister (cleanup)

```bash
# Remove ALL webhooks on the 4 boards (use with care)
npm run monday:unregister-webhooks -- --confirm

# Remove only webhooks pointing at a specific URL (e.g. switching from ngrok → Vercel)
npm run monday:unregister-webhooks -- --confirm --url https://<old-url>/api/monday/webhook
```

Requires the explicit `--confirm` flag to prevent accidents.

---

## Board → table mapping

| Monday board | Board ID | SQL items table | SQL updates table | Monday columns |
|---|---|---|---|---|
| Leads | 1236073873 | `leads_table` | `leads_updates_table` | 13 |
| Affiliates | 1237788929 | `affiliates_table` | `affiliates_updates_table` | 18 |
| Not Relevant Leads | 1237789472 | `not_relevant_leads_table` | `not_relevant_leads_updates_table` | 16 |
| Email Undelivered Leads | 1237006289 | `email_undelivered_leads_table` | `email_undelivered_leads_updates_table` | 16 |

Config lives in [lib/monday/board-registry.ts](../../lib/monday/board-registry.ts) — one-file edit to change a column map or add a board.

---

## Known limits

- **Updates in bulk sync:** 100 per item per page. Items with >100 updates will only have their first 100 synced. Webhooks catch up on changes after that.
- **Monday files/subitems:** `files` stores Monday's asset JSON as text; `subitems_count` is the count only, not the subitem rows.
- **Column values:** stored as `text` (Monday's display value) in typed SQL columns; full raw shape lives in `raw_column_values` jsonb.
- **Schema changes on Monday (added/renamed/deleted columns):** not caught by webhooks. New columns land silently in `raw_column_values` jsonb. Update `column_map` in `lib/monday/board-registry.ts` and apply an `ALTER TABLE` migration to surface them as typed columns.
