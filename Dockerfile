ARG NODE_IMAGE=node@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

FROM ${NODE_IMAGE} AS pnpm-base
RUN npm install --global --no-audit --no-fund pnpm@12.10.1

FROM pnpm-base AS build-dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM build-dependencies AS build
COPY . .
RUN pnpm build

FROM pnpm-base AS production-dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3000 \
    HOME=/home/codex \
    CODEX_WEB_TOKEN_FILE=/var/lib/codex-daemon-web/access-token
WORKDIR /app
COPY package.json ./package.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN install -d -o 1000 -g 1000 -m 0700 /home/codex /var/lib/codex-daemon-web
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
