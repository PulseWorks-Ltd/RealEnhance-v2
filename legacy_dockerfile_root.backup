# ---- Base stage ----
FROM node:22-alpine AS base
WORKDIR /app
COPY . .
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ---- Install & Build ----
FROM base AS build
WORKDIR /app
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter ./client... run build
RUN pnpm --filter @realenhance/server run build

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
CMD ["pnpm", "--filter", "@realenhance/server", "run", "start"]

