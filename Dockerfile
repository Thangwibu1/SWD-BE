# One image for every APP_ROLE; the role is chosen at runtime via APP_ROLE.
# Base image tag must match NODE_IMAGE in versions.env.
ARG NODE_IMAGE=node:22.19.0-alpine3.22

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# .npmrc sets ignore-scripts=true: better-sqlite3 loads its bundled
# linuxmusl prebuild, so no C++ toolchain or node-gyp download is needed.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --fetch-retries=5
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG K6_VERSION=v1.3.0
ARG TARGETARCH=amd64
ENV NODE_ENV=production
WORKDIR /app
USER root
RUN apk add --no-cache ca-certificates curl docker-cli docker-cli-compose openssh-client \
  && curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin --strip-components=1 "k6-${K6_VERSION}-linux-${TARGETARCH}/k6" \
  && chmod 0755 /usr/local/bin/k6
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json .npmrc ./
COPY --chown=node:node architecture-registry ./architecture-registry
COPY --chown=node:node schemas ./schemas
COPY --chown=node:node cost-catalogs ./cost-catalogs
COPY --chown=node:node database ./database
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node infra ./infra
COPY --chown=node:node workloads ./workloads
COPY --chown=node:node score-bounds ./score-bounds
COPY --chown=node:node versions.env ./versions.env
RUN mkdir -p /app/data /app/results \
  && chown -R node:node /app/data /app/results
USER node
EXPOSE 3000 4000
CMD ["node", "dist/main.js"]
