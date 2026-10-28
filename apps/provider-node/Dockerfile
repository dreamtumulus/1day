# syntax=docker/dockerfile:1
# Build context is the monorepo root:
#   docker build -f apps/provider-node/Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/provider-node/package.json apps/provider-node/package.json
RUN pnpm install --frozen-lockfile --filter @1dayapi/provider-node

COPY apps/provider-node/tsconfig.json apps/provider-node/tsconfig.json
COPY apps/provider-node/src apps/provider-node/src
RUN pnpm --filter @1dayapi/provider-node build \
  && pnpm --filter @1dayapi/provider-node deploy --prod /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PROVIDER_CONFIG_PATH=/data/config.json \
    PROVIDER_CONSOLE_HOST=0.0.0.0 \
    PROVIDER_CONSOLE_PORT=16889

COPY --from=build --chown=node:node /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 16889

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:16889/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]
