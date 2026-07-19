# Scaling from 1 VM to N VMs

> **Current fleet state (as of 2026-07-19): 2 VMs × 9 workers = 18 concurrent slots.**
> Down from 3 VMs on 2026-07-17 after utilization analysis showed <1%
> peak load. The remaining two VMs are being upgraded from 29 GB → 50
> GB EBS. See [`docs/CHANGELOG-2026-07-19.md`](./CHANGELOG-2026-07-19.md)
> for context. Fleet dimensions are read from
> [`lib/fleet.ts`](../lib/fleet.ts) — every capacity calculation
> across the app (utilization dashboard, enqueue-form queue depth,
> per-job ETAs) reads from that single constant. To scale back up,
> edit `FLEET_VM_COUNT` and follow the steps below.

This runbook covers cloning the current EC2 worker VM into a fleet of
N (you'll usually want 2 or 3) so the dashboard can dispatch scrapes
in parallel and route Captcha-solver captchas to whichever VM parked the job.

Assumes the existing single VM is already running and reachable —
the Captcha solver works, scrapes complete, etc. If not, finish
[runbook-novnc.md](./runbook-novnc.md) first.

## What changes per VM (and what doesn't)

| Per-VM unique                              | Shared across VMs                |
| ------------------------------------------ | -------------------------------- |
| Public IP / nip.io domain                  | Supabase project (DB)            |
| Let's Encrypt cert                         | `INTERACTIVE_VNC_HMAC_SECRET`    |
| `WORKER_ID` (`vm1-9222`, `vm2-9222`, …)    | GoLogin profile pool (DB-locked) |
| `VM_PUBLIC_HOST` env on workers            | Code + systemd units             |
| nginx `server_name`                        | Vercel dashboard                 |

The schema migration `20260526000000_interactive_checkpoint_vnc_host.sql`
adds a `vnc_host` column so each checkpoint knows which VM serves it.
**Apply this migration before bringing up VM 2** — older worker code
without `VM_PUBLIC_HOST` will write NULL and the dashboard falls back
to `NEXT_PUBLIC_VNC_BASE_URL` (i.e. VM 1), which routes to the wrong
box.

## Step 0 — Pre-flight on VM 1

Before snapshotting, get VM 1 into a state that won't poison the
clones.

```bash
# 1. Pull latest code on VM 1
cd ~/Google-Lead-Gen && git pull

# 2. Run the new migration in Supabase (SQL editor or `supabase db push`)
#    20260526000000_interactive_checkpoint_vnc_host.sql

# 3. Add VM_PUBLIC_HOST to ~/.env (or the per-service drop-in)
echo 'VM_PUBLIC_HOST=https://<vm1-ip>.nip.io' >> ~/.env

# 4. Restart the workers so they pick up the new env var
sudo systemctl restart 'scrape-worker@*.service'
sudo systemctl restart 'enrichment-worker@*.service'

# 5. Smoke test — kick off a scrape that you know hits a captcha.
#    Open /admin/interactive in the dashboard, click Open VNC,
#    confirm it lands on the VM 1 browser.

# 6. Once green, stop the workers cleanly so the AMI snapshot
#    captures an idle filesystem.
sudo systemctl stop 'scrape-worker@*.service'
sudo systemctl stop 'enrichment-worker@*.service'
sudo systemctl stop 'xvnc@*.service'
sudo systemctl stop 'websockify@*.service' 2>/dev/null || true
```

## Step 1 — Create the AMI

In the AWS console:

1. EC2 → Instances → select VM 1 → **Stop** (don't terminate).
2. Actions → Image and templates → **Create image**.
3. Name: `lead-gen-worker-base-YYYYMMDD`. Leave everything else default.
4. Wait ~5-10 min for AMI status to flip to **available**.
5. Start VM 1 again. *Its public IP may change* — see Step 4.

## Step 2 — Launch the new VMs

For each new VM (do 2 first, then 3 if you want a third):

1. EC2 → AMIs → select the new image → **Launch instance from AMI**.
2. **Same instance type** as VM 1 (so Chromium memory budget matches).
3. **Same security group** as VM 1 — must allow inbound 22 (SSH from
   your IP) and 443 (HTTPS, 0.0.0.0/0 for the dashboard's signed VNC
   reachability). 80 is only needed transiently for Let's Encrypt; you
   can close it after Step 5.
4. **Same SSH key pair**.
5. **Enable** "auto-assign public IP" (or attach an Elastic IP — see
   the elastic-IP note below).
6. Launch.

> **Elastic IP recommendation:** without one, every stop/start changes
> the public IP, which means re-issuing the Let's Encrypt cert + nudging
> `VM_PUBLIC_HOST` in `~/.env`. Allocate an Elastic IP per VM and
> associate it once — the AMI clone keeps the same IP across reboots.
> Idle Elastic IPs cost ~$3.60/mo; running ones are free.

## Step 3 — Per-VM bring-up

SSH to each new VM and run, **substituting the new VM's IP everywhere**:

```bash
VM_IP=<this-vm-public-ip>      # e.g. 13.211.45.92
VM_HOST=${VM_IP}.nip.io        # e.g. 13.211.45.92.nip.io

# 1. Unique WORKER_ID prefix. The AMI carries VM 1's value — overwrite it.
#    Use vm2-, vm3-, … per VM.
VM_NUM=2                       # change to 3 for the third VM
sudo sed -i "s|^WORKER_ID=vm1-|WORKER_ID=vm${VM_NUM}-|" /etc/systemd/system/scrape-worker@*.service.d/*.conf 2>/dev/null || true

# If WORKER_ID lives in ~/.env or per-port drop-ins, edit accordingly.
# Verify with: sudo systemctl cat scrape-worker@9222

# 2. Per-VM ingress host the workers stamp on checkpoint rows.
sed -i "s|^VM_PUBLIC_HOST=.*|VM_PUBLIC_HOST=https://${VM_HOST}|" ~/.env

# 3. Re-issue the Let's Encrypt cert for this VM's nip.io domain.
sudo systemctl stop nginx
sudo certbot certonly --standalone -d "${VM_HOST}" \
  --non-interactive --agree-tos --email ops@optinetsolutions.com
sudo systemctl start nginx

# 4. Patch nginx server_name so SSL matches the new host.
sudo sed -i "s|server_name [^;]*;|server_name ${VM_HOST};|" /etc/nginx/sites-available/vnc
sudo sed -i "s|ssl_certificate /etc/letsencrypt/live/[^/]*/|ssl_certificate /etc/letsencrypt/live/${VM_HOST}/|g" /etc/nginx/sites-available/vnc
sudo sed -i "s|ssl_certificate_key /etc/letsencrypt/live/[^/]*/|ssl_certificate_key /etc/letsencrypt/live/${VM_HOST}/|g" /etc/nginx/sites-available/vnc
sudo nginx -t && sudo systemctl reload nginx

# 5. Confirm the HMAC secret is identical across VMs.
#    Diff `cat /etc/default/vnc-token-verify` between VM 1 and this one;
#    they MUST match or signed URLs from the dashboard will be rejected
#    on whichever VM has the wrong secret.

# 6. Start everything back up.
sudo systemctl daemon-reload
sudo systemctl start 'xvnc@1.service' 'xvnc@2.service' 'xvnc@3.service'
sudo systemctl start 'scrape-worker@9222.service' 'scrape-worker@9223.service' 'scrape-worker@9224.service'
sudo systemctl start 'enrichment-worker@9222.service' 'enrichment-worker@9223.service' 'enrichment-worker@9224.service'

# 7. Smoke test the WSS endpoint from your laptop:
curl -i "https://${VM_HOST}/healthz"   # if you have one; otherwise hit /
```

Repeat for VM 3.

## Step 4 — If VM 1's IP changed

Stopping VM 1 to snapshot it may have released its public IP (unless
you'd already attached an Elastic IP). If so:

1. Find VM 1's new IP in the EC2 console.
2. Repeat **Step 3 items 2, 3, 4** on VM 1 with the new IP.
3. Update Vercel's `NEXT_PUBLIC_VNC_BASE_URL` to point at VM 1's new
   `https://<new-ip>.nip.io` (this is the fallback for any pre-migration
   checkpoint rows without `vnc_host`).

## Step 5 — Verify the fleet end-to-end

1. From the dashboard, queue **three scrapes for different countries**
   simultaneously (e.g. DE / IT / AU). They should claim across three
   workers on three VMs — confirm via `scrape_queue.claimed_by`
   (expect `vm1-9222`, `vm2-9222`, `vm3-9222` or similar).
2. Force a captcha (use a country with cold proxies). When the card
   appears on `/admin/interactive`, click **Open VNC**:
   - The new tab URL should contain the **VM's nip.io domain**, not
     `54.79.22.202.nip.io` (assuming the captcha came from a non-VM-1).
   - The live browser should match the keyword from the card.
3. Resume → confirm the scrape continues on the same VM.
4. From a second browser, click Open VNC on the **same card** — it
   should refuse with "Solving by <user>" (the 8-min claim).

## Notes & gotchas

- **GoLogin profile collision is already prevented** by
  `active_profile_locks`. Same country = same profile, but only one
  worker holds a country at a time across the fleet.
- **`WORKER_ID` must be unique per VM.** If two cloned VMs both report
  `vm1-9222`, the DB rows look like they belong to one worker — claim
  tracking, the activity log, and `release_stale_locks` will still
  *work*, but you'll lose the ability to tell which VM owned a job.
- **HMAC secret rotation requires touching every VM.** Plan it as a
  brief Captcha solver outage: rotate Vercel + all VMs in one window.
- **Old checkpoint rows** (created before this migration) have
  `vnc_host = NULL`. The dashboard falls back to
  `NEXT_PUBLIC_VNC_BASE_URL`, so set that to VM 1's host. New rows
  from any VM carry their own host and ignore the env.
- **DNS over nip.io** has occasional propagation hiccups. If Let's
  Encrypt fails with "DNS problem", `dig +short <host>` should return
  the IP literally encoded in the hostname — if not, retry in 30s.
