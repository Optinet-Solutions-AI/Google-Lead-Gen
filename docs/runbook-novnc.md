# VM noVNC setup (human-in-the-loop checkpoints)

This is the one-time VM setup that makes the **Open VNC** button on
`/admin/interactive` work end-to-end. After this, when the scraper
parks at a wall (captcha / age verification / cookie consent),
admins can click a dashboard link and a new tab opens onto the live
Chromium running on the VM — no SSH or VNC client needed.

## Architecture

```
┌─ browser ──────────────┐
│ /admin/interactive     │
│ → click "Open VNC"     │
│ → new tab opens        │
│   https://vnc.…/vnc/9222/?token=…
└──────────┬─────────────┘
           │ WSS, signed token in query
           ▼
┌─ VM, port 443 ─────────┐
│ nginx + Let's Encrypt  │   ← verifies the HMAC token; rejects
│                        │     expired / unsigned URLs.
│ /vnc/9222/  ──────────►│
│ /vnc/9223/  ──────────►│   websockify (one per port)
│ /vnc/9224/  ──────────►│   wraps WSS → TCP localhost:5901..3
└──────────┬─────────────┘
           │ TCP
           ▼
┌─ Xvfb display per port ┐
│ :1 (port 9222) Xvnc... │
│ :2 (port 9223) Xvnc... │
│ :3 (port 9224) Xvnc... │
└──────────┬─────────────┘
           │ DISPLAY env
           ▼
┌─ scrape-worker@9222 etc┐
│ launches Chromium /    │
│ GoLogin onto its       │
│ DISPLAY                │
└────────────────────────┘
```

Each worker port gets its own Xvfb display so when an admin opens
the noVNC stream for `/vnc/9222/` they only see the browser running
on port 9222 — no cross-talk between workers.

## Step 1 — Per-worker Xvfb + x11vnc

Today all three workers share `DISPLAY :1`. Split into three:

```bash
# x11vnc + Xvfb already installed if your existing TightVNC works.
# If not:
sudo apt install -y xvfb x11vnc

# Stop existing single-display setup if running.
# (If using systemd, identify the unit and `sudo systemctl stop` it.)

# Create one systemd unit per worker port.
sudo tee /etc/systemd/system/xvnc@.service > /dev/null <<'EOF'
[Unit]
Description=Headless X + VNC for scrape-worker port %i
After=network.target

[Service]
Type=simple
User=ubuntu
ExecStart=/bin/bash -c '\
  Xvfb :%i -screen 0 1280x1024x24 -nolisten tcp & \
  sleep 1 && \
  x11vnc -display :%i -rfbport 590%i -forever -shared -nopw \
         -localhost -quiet -bg \
  ; wait'
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

The `%i` template lets us run three instances. Map `:1` → port 5901,
`:2` → 5902, `:3` → 5903 by passing the same instance number. The
worker units need to be edited to use the matching DISPLAY:

```bash
# Edit each scrape-worker@<port>.service so its [Service] block has
# Environment=DISPLAY=:<n>:
sudo systemctl edit scrape-worker@9222
# In the editor:
#   [Service]
#   Environment=DISPLAY=:1
sudo systemctl edit scrape-worker@9223
#   Environment=DISPLAY=:2
sudo systemctl edit scrape-worker@9224
#   Environment=DISPLAY=:3
```

Same for `enrichment-worker@<port>` units — they should share the
same DISPLAY as their matching scrape-worker (so a Chromium opened
during enrichment lands on the same X screen as the scrape did).

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xvnc@1 xvnc@2 xvnc@3
sudo systemctl restart 'scrape-worker@*' 'enrichment-worker@*'
```

Verify each Xvfb display exists:

```bash
ls /tmp/.X*-lock     # expect /tmp/.X1-lock /tmp/.X2-lock /tmp/.X3-lock
```

## Step 2 — websockify (one per display)

```bash
sudo apt install -y python3-websockify

sudo tee /etc/systemd/system/websockify@.service > /dev/null <<'EOF'
[Unit]
Description=websockify proxy for VNC display :%i
After=xvnc@%i.service
Requires=xvnc@%i.service

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/bin/websockify --heartbeat=30 608%i 127.0.0.1:590%i
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now websockify@1 websockify@2 websockify@3
```

Each instance listens on:

| Display | VNC port | WSS port |
|---|---|---|
| :1 (worker 9222) | 5901 | 6081 |
| :2 (worker 9223) | 5902 | 6082 |
| :3 (worker 9224) | 5903 | 6083 |

## Step 3 — noVNC static assets

```bash
cd ~
git clone https://github.com/novnc/noVNC.git
# Symlink to a stable path nginx will serve from:
sudo ln -s /home/ubuntu/noVNC /opt/novnc
```

## Step 4 — nginx reverse proxy + token verifier sidecar

We delegate token verification to a tiny stdlib-Python sidecar
(`vm/novnc/token-verify.py`) that nginx hits via `auth_request`.
This avoids the lua-resty-hmac → luacrypto build (which fails
against OpenSSL 3 on modern Ubuntu).

```bash
sudo apt install -y nginx

# Replace <YOUR-DOMAIN> below with whatever DNS you point at the VM.
sudo tee /etc/nginx/sites-available/vnc > /dev/null <<'EOF'
# Maps each worker port → the matching websockify instance.
map $vnc_port $vnc_upstream {
    default "127.0.0.1:6081";
    "9222"  "127.0.0.1:6081";
    "9223"  "127.0.0.1:6082";
    "9224"  "127.0.0.1:6083";
}

server {
    listen 443 ssl http2;
    server_name vnc.<YOUR-DOMAIN>;

    # Let's Encrypt will populate these (Step 5).
    ssl_certificate     /etc/letsencrypt/live/vnc.<YOUR-DOMAIN>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vnc.<YOUR-DOMAIN>/privkey.pem;

    # Static noVNC HTML/JS files.
    location ~ ^/vnc/(?<vnc_port>922[2-4])/$ {
        alias /opt/novnc/;
        try_files vnc_lite.html =404;
    }
    location /vnc/ {
        alias /opt/novnc/;
    }

    # Internal auth endpoint that nginx hits before allowing any WS
    # upgrade. The vnc-token-verify systemd unit (Python stdlib HTTP
    # server on 127.0.0.1:8765) does HMAC + expiry + port check and
    # returns 200 (allow) or 401 (deny). Variables from the outer
    # regex location ($vnc_port, $arg_token) are interpolated into
    # the auth subrequest URI so the verifier sees them.
    location = /_auth {
        internal;
        proxy_pass http://127.0.0.1:8765/verify?token=$arg_token&port=$arg_port;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
    }

    # The actual WebSocket endpoint. websockify expects the request
    # at the root path, so we rewrite /vnc/<port>/websockify → /.
    location ~ ^/vnc/(?<vnc_port>922[2-4])/websockify$ {
        auth_request /_auth?token=$arg_token&port=$vnc_port;

        proxy_pass http://$vnc_upstream/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host       $host;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}

server {
    listen 80;
    server_name vnc.<YOUR-DOMAIN>;
    return 301 https://$host$request_uri;
}
EOF

sudo ln -sf /etc/nginx/sites-available/vnc /etc/nginx/sites-enabled/vnc

# Pull the verifier sidecar from the repo + run as systemd unit.
curl -fsSL https://raw.githubusercontent.com/Optinet-Solutions-AI/Google-Lead-Gen/main/vm/novnc/token-verify.py \
  -o /home/ubuntu/vnc-token-verify.py
chmod +x /home/ubuntu/vnc-token-verify.py

sudo tee /etc/systemd/system/vnc-token-verify.service > /dev/null <<'EOF'
[Unit]
Description=HMAC token verifier for noVNC URLs
After=network.target

[Service]
Type=simple
User=ubuntu
# Generate the shared secret once with: openssl rand -hex 32
# The same value goes into the Vercel env var of the same name.
Environment=INTERACTIVE_VNC_HMAC_SECRET=PASTE-THE-SAME-VALUE-AS-IN-VERCEL-ENV
ExecStart=/usr/bin/python3 /home/ubuntu/vnc-token-verify.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now vnc-token-verify
sudo systemctl reload nginx
```

## Step 5 — Let's Encrypt cert

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d vnc.<YOUR-DOMAIN>
```

certbot edits the nginx server block to plug in the `fullchain.pem` /
`privkey.pem` paths and sets up auto-renewal.

## Step 6 — Vercel env vars

In the Vercel dashboard for the lead-gen project:

```
NEXT_PUBLIC_VNC_BASE_URL          = https://vnc.<YOUR-DOMAIN>
INTERACTIVE_VNC_HMAC_SECRET       = <same hex value as on the VM>
```

Redeploy.

## Smoke test

1. Queue a scrape that reliably triggers a captcha (e.g. a country
   you haven't logged into Google on, or a keyword Google flags).
2. Wait for the scrape to start. The dashboard should show
   `1 scrape waiting for human` at the top within a minute.
3. Click → land on `/admin/interactive` → click **Open VNC** on the
   waiting card.
4. New tab opens noVNC. You should see the live Chromium on the VM.
5. Solve the captcha manually.
6. Close the noVNC tab, click **Resume** on the dashboard card.
7. Scrape resumes from where it paused; the row eventually flips to
   `completed` on `/scrape`.

## Troubleshooting

- **Click Open VNC, get 401**: the HMAC secret in `/etc/default/nginx`
  doesn't match the one in Vercel. Rebuild + redeploy + reload nginx.
- **Click Open VNC, see blank screen**: noVNC connected but the X
  display is empty. Probably means the worker's DISPLAY env var
  doesn't match the Xvfb instance. Check `systemctl cat scrape-worker@9222 | grep DISPLAY`.
- **Every time I refresh, the URL says expired**: signed URLs are
  short-lived (15 min). Click the dashboard's refresh — it generates
  a new one.
- **Resume doesn't continue the scrape**: scrapers poll every 5s,
  so it can take that long. Watch `journalctl -u 'scrape-worker@*' -f`
  on the VM for `[INFO] checkpoint resolved by operator`.
