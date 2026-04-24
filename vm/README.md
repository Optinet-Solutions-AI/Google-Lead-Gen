# VM scrape worker — deployment guide

Three Python processes per VM, each on a different GoLogin port, all polling the same `scrape_queue` in Supabase. One queue, N workers, zero coordination — scale by running the same thing on another VM.

## What lives on the VM

Only four files. Everything else stays in the Next.js repo.

| VM path | Source in repo |
|---|---|
| `~/scraper.py` | [scraper.py](../scraper.py) |
| `~/kill_gologin.py` | [kill_gologin.py](../kill_gologin.py) |
| `~/worker.py` | [vm/worker.py](worker.py) |
| `/etc/systemd/system/scrape-worker@.service` | [vm/scrape-worker@.service](scrape-worker@.service) |
| `~/.env` | template at [vm/.env.example](.env.example) |

## Deploy / update (one command)

Repo is public, so you can pull the four files directly with `curl`. Run this on the VM any time you edit something in the repo and want the VM to catch up.

```bash
BASE=https://raw.githubusercontent.com/Optinet-Solutions-AI/Google-Lead-Gen/main

curl -fL -o ~/scraper.py                                          "$BASE/scraper.py"
curl -fL -o ~/kill_gologin.py                                     "$BASE/kill_gologin.py"
curl -fL -o ~/worker.py                                           "$BASE/vm/worker.py"
sudo curl -fL -o /etc/systemd/system/scrape-worker@.service       "$BASE/vm/scrape-worker@.service"

sudo systemctl daemon-reload
sudo systemctl restart 'scrape-worker@*' 2>/dev/null || true
```

The last line restarts any already-enabled worker instances so they pick up the new code. Harmless if none are running yet.

## One-time setup

Do this once per VM. Skip on subsequent deploys.

### 1. System + Python dependencies

```bash
sudo apt-get update
sudo apt-get install -y python3-pip python3-venv xvfb x11vnc

pip3 install --user \
  gologin selenium beautifulsoup4 requests \
  supabase python-dotenv psutil
```

### 2. Fetch the files

Same command as the "Deploy / update" block above.

### 3. Create `~/.env`

Copy [vm/.env.example](.env.example) — either via curl or paste — and fill in the real values:

```
WORKER_ID=vm1-9222                    # overridden per instance by the systemd unit
GOLOGIN_PORT=9222                     # overridden per instance
POLL_INTERVAL_SECONDS=5
SCRAPE_TIMEOUT_SECONDS=1200
SUPABASE_URL=https://veqfloktkejmyueskltp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
GOLOGIN_API_TOKEN=eyJhbGci...         # was hardcoded in Python, now lives here
DISPLAY=:1
```

### 4. Enable three workers

```bash
sudo systemctl enable --now scrape-worker@9222
sudo systemctl enable --now scrape-worker@9223
sudo systemctl enable --now scrape-worker@9224
```

Each reads the same `~/.env` but the unit file overrides `WORKER_ID=vm1-<port>` and `GOLOGIN_PORT=<port>` so the three Chromiums don't fight for the same debugger port.

## Verify

```bash
sudo journalctl -u scrape-worker@9222 -f
# Expect:  worker started | port=9222 poll=5s
```

Insert a test job from the Supabase SQL editor:

```sql
insert into scrape_queue (keyword, country_code, pages)
values ('Top 10 online casinos', 'DE', 1);
```

Within ~5 s one of the three workers claims it (`scrape_queue.status` → `running`, a row appears in `active_profile_locks` for `DE`). In 2–4 min the status flips to `completed` and rows land in `google_lead_gen_table`.

## Scaling to VM #2

Same deploy commands, same `~/.env` template, but set `WORKER_ID=vm2-9222` etc. so you can tell the VMs apart in logs and the `claimed_by` column. No Next.js change, no queue config change, nothing else.

## Troubleshooting

```bash
# Graceful stop (drains current job)
sudo systemctl stop scrape-worker@9222

# Force-kill anything stuck on a port
python3 ~/kill_gologin.py 9222

# Jobs stuck in 'running'?  Manually requeue after 30 min cap:
# (in Supabase SQL editor)
select release_stale_locks(30);
```

## Concurrency guarantee

Even with all workers running, two scrapes for the **same country** can't execute at the same time. The `active_profile_locks` table (primary key on `country_code`) blocks that at the database level — `claim_scrape_job` returns `NULL` if another worker holds the country, so the waiting worker picks a different pending job instead. Same-country work always serializes.
