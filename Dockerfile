FROM node:22-alpine

WORKDIR /app
RUN corepack enable

# 1) Copy workspace manifests and install deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY shared/package.json shared/package.json

RUN pnpm install --frozen-lockfile

# 2) Copy the actual monorepo source code
COPY . .

# 3) Build shared + server
RUN pnpm --filter @realenhance/shared build
RUN pnpm --filter @realenhance/server build

# 4) Run compiled server
WORKDIR /app/server
ENV NODE_ENV=production
CMD ["pnpm", "start"]
