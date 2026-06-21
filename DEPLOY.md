# 🚀 Deploying CTB with Docker / Coolify

CTB ships as **one self-contained Docker image**: the Fastify server + the
visual editor SPA + an embedded **SQLite** database — no external DB or extra
services required. This guide walks the **Coolify UI** path (no terminal), then
plain Docker as a fallback.

> **What you get:** one container on port **3000** serving both the admin panel
> (the editor) and the bot runtime. All state (bots, flows, executions,
> collection records + uploaded files, encrypted credentials) lives in a single
> `/app/data` volume — **persist that volume** and your data survives redeploys.

---

## ✅ Before you start — two required secrets

You only *must* set two environment variables:

| Variable | What it is | How to get it |
|---|---|---|
| `CTB_SECRET` | Master key that encrypts credentials at rest + signs login sessions. **Min 16 chars.** | Generate a strong random value, e.g. `openssl rand -hex 24`, or any password manager's 40+ char random string. **Keep it stable** — changing it makes existing encrypted credentials unreadable. |
| `CTB_ADMIN_PASS` | Your admin panel password. The panel returns **503** until this is set. | Pick a strong password. The username defaults to `admin` (`CTB_ADMIN_USER`). |

Everything else has safe defaults (see the full table at the bottom).

---

## 🅰️ Option A — Coolify (UI only, recommended)

Three flavours. **A0 (pre-built image from GHCR)** is the fastest "just deploy
the image" path. **A1 (Dockerfile build from Git)** builds it yourself.

### A0 — Deploy the pre-built image from GHCR (no build) ⭐

Every push to `main` (and every `vX.Y.Z` Git tag / published Release) is built by
GitHub Actions (`.github/workflows/docker-publish.yml`) and published to the
GitHub Container Registry:

```
ghcr.io/saeedkhoshafsar/ctb:latest
```

> **One-time:** make the package public so Coolify can pull it without creds —
> GitHub → your profile → **Packages → ctb → Package settings → Change
> visibility → Public**. (Or, to keep it private, add a GHCR source under
> Coolify **Keys & Tokens / Sources** with a PAT that has `read:packages`.)

In Coolify:

1. **New Resource → Docker Image.**
2. **Docker Image:** `ghcr.io/saeedkhoshafsar/ctb`  **Tag:** `latest`
   (or a pinned version like `1.0.0`).
3. **Ports Exposes:** `3000`.
4. **Environment Variables:** add `CTB_SECRET` + `CTB_ADMIN_PASS` (see top).
5. **Persistent Storage → Add → Volume Mount:** Name `ctb-data`, Mount Path
   `/app/data`.
6. **Healthcheck:** Type `HTTP`, Method `GET`, Scheme `http`, Host `localhost`,
   **Port `3000`**, **Path `/healthz`**, Return Code `200`, Start Period `20`.
7. **Pre/Post-deployment commands:** leave **empty** (CTB auto-migrates on boot;
   the `php artisan migrate` placeholder is just example text — do not use it).
8. **Deploy.** Login `admin` / your `CTB_ADMIN_PASS`.

To upgrade later: just **Redeploy** (pulls the newest `:latest`) — your
`/app/data` volume keeps every bot, flow and credential.

### A1 — Build from your Git repo (Dockerfile)

1. **New Resource → Application.**
2. **Source:** pick your Git provider and select this repository
   (`Saeedkhoshafsar/CTB`), branch `main`.
3. **Build Pack:** choose **`Dockerfile`**. Coolify auto-detects the `Dockerfile`
   in the repo root — leave the path as `/Dockerfile`.
4. **Port:** set the **Ports Exposes** field to **`3000`**.
5. **Environment Variables** (Configuration → Environment Variables) — add:
   ```
   CTB_SECRET=<your 24+ char random secret>
   CTB_ADMIN_PASS=<your admin password>
   ```
   (Optional extras are in the table below.)
6. **Persistent Storage** (Storages → Add) — this is the important one so your
   data isn't wiped on redeploy:
   - **Name:** `ctb-data`
   - **Mount Path:** `/app/data`
   (Source/host path can be left to Coolify's managed volume.)
7. **Health check:** the image already declares a Docker `HEALTHCHECK` hitting
   `GET /healthz`. Coolify will use it automatically. (If you prefer to set it in
   the UI: Health Check path `/healthz`, port `3000`.)
8. Click **Deploy**. First build takes a few minutes (it compiles the native
   SQLite module and builds the editor).
9. When it's healthy, open the app URL Coolify shows you and log in with
   `admin` / your `CTB_ADMIN_PASS`.

> **Custom domain + HTTPS:** add your domain under the app's **Domains** field;
> Coolify provisions the TLS certificate for you. If you'll run a bot in
> **webhook mode**, also set `CTB_PUBLIC_URL` to that `https://…` domain
> (polling-mode bots don't need it).

### A2 — Deploy the Docker Compose file

If you'd rather use the bundled `docker-compose.yml`:

1. **New Resource → Docker Compose.**
2. Point it at this repo; Coolify reads `docker-compose.yml` from the root.
3. Set the same **Environment Variables** (`CTB_SECRET`, `CTB_ADMIN_PASS`, …) —
   the compose file passes them through.
4. The compose file already declares the `ctb_data` named volume + the
   healthcheck. Deploy.

---

## 🅱️ Option B — Plain Docker (no Coolify)

```bash
# 1. Configure
cp .env.example .env
#   edit .env → set CTB_SECRET (openssl rand -hex 24) and CTB_ADMIN_PASS

# 2. Build + run
docker compose up -d --build

# 3. Check health + open it
docker compose ps          # STATUS should become "healthy"
#   browse to http://<server-ip>:3000  → login admin / <CTB_ADMIN_PASS>
```

Or without compose:

```bash
docker build -t ctb:latest .
docker volume create ctb_data
docker run -d --name ctb -p 3000:3000 \
  -e CTB_SECRET="$(openssl rand -hex 24)" \
  -e CTB_ADMIN_PASS="change-me" \
  -v ctb_data:/app/data \
  --restart unless-stopped \
  ctb:latest
```

---

## 🔁 Redeploys & upgrades

- Your data lives in the **`/app/data` volume** — as long as you keep the same
  persistent storage, redeploying a new image keeps every bot, flow, record and
  credential. Database **migrations run automatically on boot**.
- **Never change `CTB_SECRET` after first boot** — it decrypts stored
  credentials and signs sessions; a new value orphans existing encrypted data.
- To back up: snapshot/copy the `/app/data` volume (it's just a SQLite file +
  an uploaded-files folder).

---

## 🩺 Health & troubleshooting

- **Health endpoint:** `GET /healthz` → `{ "ok": true }`. The container's
  `HEALTHCHECK` polls it every 30s.
- **Won't start / 503 on login:** `CTB_ADMIN_PASS` is unset — set it and
  redeploy.
- **"Invalid environment configuration":** usually `CTB_SECRET` is missing or
  shorter than 16 characters.
- **Bot using webhooks doesn't receive updates:** set `CTB_PUBLIC_URL` to your
  public `https://` domain and make sure the domain reaches the container.
  (Polling-mode bots need no public URL.)
- **Logs:** in Coolify, the app's **Logs** tab; with Docker, `docker logs ctb`.

---

## ⚙️ Full environment reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CTB_SECRET` | **yes** | — | Encryption-at-rest + session signing key (≥16 chars). Keep stable. |
| `CTB_ADMIN_PASS` | **yes** | — | Admin panel password (panel is 503 until set). |
| `CTB_ADMIN_USER` | no | `admin` | Admin username. |
| `CTB_OPERATOR_USER` | no | `operator` | "Manager" login that sees **only** Collections Data. |
| `CTB_OPERATOR_PASS` | no | *(unset → disabled)* | Set to enable the operator login. |
| `CTB_PUBLIC_URL` | only for webhook bots | *(unset)* | Public `https://` base URL for Telegram webhooks. |
| `CTB_CODE_HTTP_ALLOWLIST` | no | *(unset → unrestricted)* | Comma-separated host allow-list for the Code node's `$http` (`.example.com` = any subdomain). |
| `CTB_PORT` | no | `3000` | HTTP listen port (container). |
| `CTB_HOST` | no | `0.0.0.0` | HTTP bind address. |
| `CTB_DB_PATH` | no | `/app/data/ctb.sqlite` | SQLite file path (on the volume). |
| `CTB_DATA_DIR` | no | `/app/data` | Uploaded Collection files dir (on the volume). |
| `NODE_ENV` | no | `production` | Runtime mode. |

> 🎙️ **Live voice (Phase E):** real-time Telegram calls need a `voiceConnection`
> credential (an MTProto **user** session) configured *inside* the panel — see
> `docs/PROTOCOL.md` → "Live voice" for connector kinds, the credential, and the
> ToS posture. No extra container env is required for it; the default in-memory
> loopback connector ships built-in.
