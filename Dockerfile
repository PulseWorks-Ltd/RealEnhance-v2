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


# Build shared first, then the selected service (fail loudly if build fails)
ARG SERVICE=server
RUN pnpm --filter @realenhance/shared build
RUN pnpm --filter @realenhance/$SERVICE build

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

# Copy only what the selected service needs at runtime
ARG SERVICE=server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/${SERVICE} ./${SERVICE}
COPY --from=builder /app/${SERVICE}/dist ./${SERVICE}/dist

# Set working directory and expose port for server/worker
WORKDIR /app/${SERVICE}

# Expose port 3000 only for server
ARG SERVICE=server
RUN if [ "$SERVICE" = "server" ]; then echo "EXPOSE 3000" > /tmp/expose; fi

# Start the correct service
CMD ["pnpm", "start"]
