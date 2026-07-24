# Runbook — Stag Render Worker deploy

**What this deploys:** the Playwright/Chromium worker that fixes the 26.5% FETCH_EMPTY bucket in the S-tag audit — sites returning near-empty HTML because they're React/Next SPAs. Once live, the worker re-fetches those URLs in a real Chromium session and persists the post-JS HTML into `fetched_html_cache`. The standard extraction pipeline then finds the tag on the next scoring pass.

**Ceiling:** ~+24.5pp overall (fetches everything in the FETCH_EMPTY bucket that the widened extractor can then successfully parse).

## Deploy — three commands

### 1. Apply the migration (once, from local dev)

```bash
npx tsx scripts/db/apply-migration.ts --apply supabase/migrations/20260724060000_stag_render_worker.sql
```

Adds `render_claimed_by` / `render_claimed_at` / `render_completed_at` columns on `fetched_html_cache`, plus `claim_stag_render_batch()` and `release_stale_render_claims()` RPCs. Zero risk — additive columns, new RPCs, no data movement.

### 2. Add env var on each VM (once)

SSH each VM. Append one line to `/home/ubuntu/.env`:

```bash
echo "DEFAULT_STAG_RENDER_PROFILE_ID=<any-active-gologin-profile-id>" | sudo tee -a /home/ubuntu/.env
```

Pick any active GoLogin profile — country doesn't matter much for extraction. Copy the ID from `/profiles` on the dashboard, or reuse an existing scrape worker's profile ID from `/home/ubuntu/.env`.

Optional overrides (defaults are usually fine):

```bash
STAG_RENDER_BATCH_SIZE=8    # leads per Chromium session
STAG_RENDER_SETTLE_S=3      # wait after DOMContentLoaded
STAG_RENDER_PAGE_TIMEOUT=15 # hard nav timeout in seconds
```

### 3. Curl the worker + systemd unit + enable (each VM)

```bash
# On VM1, then repeat on VM2
curl -sSL -o ~/stag_render_worker.py \
  https://raw.githubusercontent.com/Optinet-Solutions-AI/Google-Lead-Gen/main/vm/stag_render_worker.py

curl -sSL -o /tmp/stag-render-worker@.service \
  https://raw.githubusercontent.com/Optinet-Solutions-AI/Google-Lead-Gen/main/vm/stag-render-worker@.service
sudo cp /tmp/stag-render-worker@.service /etc/systemd/system/
sudo systemctl daemon-reload

# 3 render workers per VM on dedicated ports (9231-9233 don't
# collide with scrape 9222-9227 or enrichment 9228-9230).
sudo systemctl enable --now \
  stag-render-worker@9231 \
  stag-render-worker@9232 \
  stag-render-worker@9233

# Confirm they came up
systemctl status 'stag-render-worker@*' --no-pager | head -30
```

## Verify + measure

Once workers are running they'll immediately start claiming batches from the RPC and rendering. To watch the first batch clear:

```bash
sudo journalctl -u 'stag-render-worker@*' -f | grep -E 'render lead|Batch of'
```

Expect ~3-5 seconds per lead. With 3 workers per VM × 2 VMs = 6 render workers, the ~420 leads in the FETCH_EMPTY bucket clear in ~20 minutes.

## Score the newly-rendered HTML

The render worker only guarantees rendered HTML lands in `fetched_html_cache`. Scoring happens through the existing bulk re-extract script — run this **after the render batch clears**:

```bash
# Dry run first — shows how many new tags the widened extractor
# will pick up from the freshly-rendered HTML.
npx tsx scripts/qa/_bulk-re-extract-cached-html.ts

# Apply to persist:
npx tsx scripts/qa/_bulk-re-extract-cached-html.ts --apply
```

Then re-audit:

```bash
npx tsx scripts/qa/_stag-extraction-audit-v2.ts
```

Compare the new numbers against the baseline at the top of `scripts/qa/_stag-extraction-audit-v2.ts`. Success = FETCH_EMPTY drops close to zero and SUCCESS rises accordingly.

## Rollback (if needed)

Just disable + stop the units:

```bash
sudo systemctl disable --now stag-render-worker@9231 stag-render-worker@9232 stag-render-worker@9233
```

The migration itself is safely reversible — the added columns default to NULL and no existing code path references them until the worker is running.

## Troubleshooting

**Worker keeps restarting.**
`journalctl -u stag-render-worker@9231 -n 100`. Common causes:
- `DEFAULT_STAG_RENDER_PROFILE_ID` not set → exits with code 2, restart loop
- GoLogin profile expired → check the profiles list
- Chromium not installed at the standard path (same one scrape-worker uses)

**Worker running but no rows being claimed.**
Check the RPC directly:
```bash
npx tsx -e '
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }});
const { data, error } = await s.rpc("claim_stag_render_batch", { p_worker_id: "manual-check", p_batch_size: 3 });
console.log({ data, error });
'
```

Empty data = nothing to render (bucket already cleared). Non-empty = the workers should be picking it up; check `render_claimed_by` on the returned rows.

**Rendered HTML looks the same as before.**
Some SPAs render blank without a real user-agent or cookies. The worker uses whatever `DEFAULT_STAG_RENDER_PROFILE_ID` is configured — if a specific site keeps failing, try a different country profile with a `.co.uk` / `.de` / `.au` resident profile that matches the site's expected geography.
