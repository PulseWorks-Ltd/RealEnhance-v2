# -----------------------------
# Base image with pnpm enabled
# -----------------------------
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# -----------------------------
# Dependencies layer
# -----------------------------
FROM base AS deps

# Copy only files needed to resolve workspaces & install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json

# Install all workspace deps (including @realenhance/shared + server)
RUN pnpm install --frozen-lockfile

# -----------------------------
# Build layer
# -----------------------------
FROM deps AS builder

# Now copy the full monorepo (server + shared + anything else)
COPY . .

# Build shared first (if needed), then server
RUN pnpm --filter @realenhance/shared build || echo "no shared build script"
RUN pnpm --filter @realenhance/server build

# -----------------------------
# Runtime image
# -----------------------------
FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable

ENV NODE_ENV=production

# Copy root package + node_modules so workspace resolution still works
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules

# Copy only what the server needs at runtime
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server

# Copy built output for server and worker
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/worker/dist ./worker/dist

WORKDIR /app/server

EXPOSE 3000

CMD ["pnpm", "start"]
