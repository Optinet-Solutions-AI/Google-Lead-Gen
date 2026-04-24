# VM scrape worker — deployment guide

Three Python processes per VM, each on a different GoLogin port, all polling the same `scrape_queue` in Supabase. One queue, N workers, zero coordination — scale by running the same thing on another VM.

## What lives on the VM

| Path | Purpose | Edit in this repo? |
|---|---|---|
| `~/gologin_start_profile_api_and_webscrape.py` | The scraper | Yes (edit in repo, scp over) |
| `~/kill_gologin.py` | Kills whatever is on a given port | Yes |
| `~/worker.py` | **New.** The polling daemon | Yes |
| `~/.env` | Secrets (GoLogin token, Supabase URL + service key, worker id + port) | No — one copy per VM, see `.env.example` |
| `/etc/systemd/system/scrape-worker@.service` | Systemd template that runs N workers | Yes |

The source of truth for the first three + the systemd unit is this repo. Deploy = `scp` them over (or `git pull` if the VM clones the repo).

## One-time VM setup

```bash
# System deps (Ubuntu; adjust for other distros)
sudo apt-get update
sudo apt-get install -y python3-pip python3-venv xvfb x11vnc

# Python deps for the scraper + worker
pip3 install --user gologin selenium beautifulsoup4 requests supabase python-dotenv psutil

# Place files
cp gologin_start_profile_api_and_webscrape.py ~/
cp kill_gologin.py                             ~/
cp vm/worker.py                                ~/
cp vm/.env.example                             ~/.env     # edit with real values

sudo cp vm/scrape-worker@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Fill in `~/.env`:

```
WORKER_ID=vm1-9222                    # overridden per instance by the systemd unit
GOLOGIN_PORT=9222                     # overridden per instance
POLL_INTERVAL_SECONDS=5
SCRAPE_TIMEOUT_SECONDS=1200
SUPABASE_URL=https://veqfloktkejmyueskltp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
GOLOGIN_API_TOKEN=eyJhbGci...         # was hardcoded in the Python source; now here
DISPLAY=:1
```

## Start three workers

```bash
sudo systemctl enable --now scrape-worker@9222
sudo systemctl enable --now scrape-worker@9223
sudo systemctl enable --now scrape-worker@9224
```

Each instance reads the same `.env` but the systemd unit overrides `WORKER_ID=vm1-<port>` and `GOLOGIN_PORT=<port>`. That way three Chromiums don't fight for the same debugger port.

## Verify

```bash
# Follow logs of one worker
sudo journalctl -u scrape-worker@9222 -f

# Expect on startup:
#   [INFO] worker started | port=9222 poll=5s

# Insert a test row from Supabase SQL editor or the Next.js UI (commit 4):
#   insert into scrape_queue (keyword, country_code, pages)
#     values ('Top 10 online casinos', 'DE', 1);

# One of the three workers picks it up within ~5 s.
```

## Scaling to VM #2

Identical steps on the new VM. Only difference: bump the `WORKER_ID` prefix (`vm2-9222`, `vm2-9223`, `vm2-9224`) so you can tell them apart in logs + the `claimed_by` column. No Next.js change, no queue config change, nothing else.

## Stopping / troubleshooting

```bash
# Graceful stop (drains the current job)
sudo systemctl stop scrape-worker@9222

# Force-kill any stuck GoLogin / Chromium on a port
python3 ~/kill_gologin.py 9222

# See claimed-but-not-finished jobs in Supabase:
#   select * from scrape_queue where status = 'running' order by started_at;
# If any are stale (started > 30 min ago), Supabase's release_stale_locks()
# RPC requeues them — runs automatically if you set up pg_cron, or call
# it manually:
#   select release_stale_locks(30);
```

## Concurrency guarantee

Even with all workers running, two scrapes for the SAME country can't execute at the same time. The `active_profile_locks` table (primary key on `country_code`) blocks that at the database level — the `claim_scrape_job` RPC returns NULL if another worker is currently holding the country. The second worker just tries the next pending job instead.

So "3 workers on one VM" really means "up to 3 DIFFERENT countries in parallel at any instant." Same-country work always serializes.
