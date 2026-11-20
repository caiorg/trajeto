# Imagem da API. Contexto de build: a raiz do repositório (o workspace precisa de `packages/core`).
#   docker build -f apps/api/Dockerfile .

FROM oven/bun:1.3.6-slim AS deps
WORKDIR /app
# O lockfile cobre todos os workspaces: os manifestos de todos precisam estar presentes.
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
# Só a API e suas dependências de workspace; o app mobile (Expo) fica de fora.
RUN bun install --frozen-lockfile --filter @wayboo/api --ignore-scripts

# Node, não Bun: a API usa `node:sqlite`.
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/wayboo.db
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages/core packages/core
COPY apps/api apps/api
# Volumes nomeados herdam o dono destas pastas na primeira montagem.
RUN mkdir -p /data /srv/map && chown node:node /data /srv/map
USER node
WORKDIR /app/apps/api
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]
