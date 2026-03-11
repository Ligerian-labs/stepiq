FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* bunfig.toml* ./
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/landing/package.json apps/landing/
COPY apps/app/package.json apps/app/
COPY apps/worker/package.json apps/worker/
RUN bun install --frozen-lockfile || bun install

FROM base AS build
RUN apk add --no-cache go
COPY --from=deps /app .
COPY tsconfig.json ./
COPY packages/core packages/core
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN bun tsc -p packages/core/tsconfig.json && bun tsc -p apps/api/tsconfig.json && bun run --filter @stepiq/worker build

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY package.json ./

CMD ["bun", "run", "apps/worker/dist/index.js"]
