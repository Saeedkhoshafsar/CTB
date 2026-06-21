# syntax=docker/dockerfile:1
#
# CTB — Composable Telegram Bots — production image for Coolify / Docker.
#
# Multi-stage:
#   1) deps    — install ALL workspace deps (better-sqlite3 compiles here).
#   2) build   — build the editor SPA (apps/editor/dist).
#   3) runtime — slim image that runs the TS server directly with tsx.
#
# The server is run by `tsx` straight from the TypeScript sources (no JS build
# step for the backend in pre-1.0), and serves the prebuilt editor SPA as static
# files. SQLite data lives on a mounted volume at /app/data (persist this in
# Coolify so bots/flows survive redeploys).
#
# Exposed port: 3000 (override with CTB_PORT). Health check: GET /healthz.

# ─────────────────────────────────────────────────────────────────────────────
# 1) deps — install workspace dependencies (native modules compile here)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 builds a native addon → needs python3 + a C/C++ toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so `npm ci` is cached until a manifest changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json   packages/shared/
COPY packages/core/package.json     packages/core/
COPY packages/nodes/package.json    packages/nodes/
COPY packages/sandbox/package.json  packages/sandbox/
COPY apps/server/package.json       apps/server/
COPY apps/editor/package.json       apps/editor/

RUN npm ci --no-audit --no-fund

# ─────────────────────────────────────────────────────────────────────────────
# 2) build — compile the editor SPA
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build -w apps/editor

# ─────────────────────────────────────────────────────────────────────────────
# 3) runtime — slim image that runs the server
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    CTB_HOST=0.0.0.0 \
    CTB_PORT=3000 \
    CTB_DB_PATH=/app/data/ctb.sqlite \
    CTB_DATA_DIR=/app/data

# A tiny init (`tini`) reaps zombies + forwards SIGTERM so the server's graceful
# shutdown (leave live calls, flush DB) actually runs on `docker stop`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini wget \
  && rm -rf /var/lib/apt/lists/*

# Bring over the installed deps (with the compiled better-sqlite3), the source,
# and the freshly built editor SPA from the build stage.
COPY --from=build /app/node_modules        ./node_modules
COPY --from=build /app/package.json        ./package.json
COPY --from=build /app/package-lock.json   ./package-lock.json
COPY --from=build /app/packages            ./packages
COPY --from=build /app/apps/server         ./apps/server
COPY --from=build /app/apps/editor/dist    ./apps/editor/dist
COPY --from=build /app/apps/editor/package.json ./apps/editor/package.json

# Persisted state (SQLite DB + uploaded Collection files) lives here.
RUN mkdir -p /app/data \
  && chown -R node:node /app
VOLUME ["/app/data"]

# Drop root.
USER node

EXPOSE 3000

# Coolify reads this; it also gives `docker ps` an accurate health column.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${CTB_PORT}/healthz" || exit 1

# OCI metadata (nice in registries / Coolify).
LABEL org.opencontainers.image.title="CTB — Composable Telegram Bots" \
      org.opencontainers.image.description="Visual, node-based Telegram bot automation platform (n8n-style, conversation-aware)." \
      org.opencontainers.image.source="https://github.com/Saeedkhoshafsar/CTB"

# tini as PID 1 → clean signal handling for graceful shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
# tsx runs the TS server sources directly; DB migrations run automatically on boot.
CMD ["npx", "tsx", "apps/server/src/main.ts"]
