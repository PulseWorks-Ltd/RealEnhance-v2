FROM node:20-slim

# Use Corepack to manage pnpm
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Workspace manifests for a reproducible install (no source yet)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY worker/package.json worker/

# Install only the packages we need (shared + worker) to reduce surface and avoid odd caching
RUN pnpm --filter @realenhance/shared --filter @realenhance/worker install --no-frozen-lockfile --prefer-offline

# Bring in source only for packages we build/run
COPY shared ./shared
COPY worker ./worker

# Build shared first (types/runtime), then the worker (no workspace flag needed)
RUN pnpm -C shared build \
 && pnpm -C worker build

WORKDIR /app/worker
ENV NODE_ENV=production
CMD ["node", "dist/worker/src/worker.js"]
