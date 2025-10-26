# 1. Build stage
FROM node:18 AS build

# Ensure corepack is available and pnpm is enabled
RUN corepack enable pnpm

# Create app dir
WORKDIR /app

# Copy the whole monorepo for build
COPY . /app

# Install deps for all workspaces
RUN pnpm install --no-frozen-lockfile

# Build frontend (client) and backend (server)
RUN pnpm --filter ./client... run build
RUN pnpm --filter ./server... run build

# 2. Runtime stage
FROM node:18 AS runtime

# Enable pnpm in the runtime container too (for pnpm start)
RUN corepack enable pnpm

# Create app dir
WORKDIR /app

# Copy only what we need from build stage, not node_modules bloat from every workspace
COPY --from=build /app /app

# Expose port for Railway
ENV PORT=8080
EXPOSE 8080

# Required env for production mode
ENV NODE_ENV=production

# Start server workspace
CMD pnpm --filter ./server... run start
