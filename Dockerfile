FROM node:22-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY shared/package.json shared/package.json

RUN pnpm install --frozen-lockfile

# 🔥 THE CRITICAL LINE
COPY . .

RUN pnpm --filter @realenhance/shared build
RUN pnpm --filter @realenhance/server build

WORKDIR /app/server
ENV NODE_ENV=production
CMD ["pnpm", "start"]
