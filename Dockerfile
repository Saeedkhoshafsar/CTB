# CTB — multi-stage build: workspaces install → editor build → slim runtime.
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install all workspace deps (better-sqlite3 compiles here, needs python3/make/g++)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/nodes/package.json packages/nodes/
COPY packages/sandbox/package.json packages/sandbox/
COPY apps/server/package.json apps/server/
COPY apps/editor/package.json apps/editor/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build -w apps/editor

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
VOLUME ["/app/data"]
# tsx runs the TS sources directly; dist-less runtime keeps the image simple in pre-1.0.
CMD ["npx", "tsx", "apps/server/src/main.ts"]
