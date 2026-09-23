# api/Dockerfile
# Release imageはTypeScriptとproduction dependencyをbuild時に確定し、起動時に
# source buildやnpm installを行わない。digest更新はDependabotで追跡する。
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build-deps

WORKDIR /app

# lzma-native はネイティブビルドが必要 (python3 + make + g++ + bzip2 for tar.bz2 extraction)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ bzip2 \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# bind mountしたsourceをtsx watchで動かすdev専用target。
FROM build-deps AS development
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npx", "tsx", "internal.ts"]

FROM build-deps AS build
RUN npm run build \
 && npm prune --omit=dev

# OCIとして配布するproduction target。compilerとsourceは持ち込まない。
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS release
ARG MADO_VERSION=dev
ARG VCS_REF=""
ARG BUILD_DATE=""
LABEL org.opencontainers.image.title="Mado API" \
      org.opencontainers.image.description="Mado internal and OpenLineage APIs" \
      org.opencontainers.image.source="https://github.com/aida0710/mado" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$MADO_VERSION" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE"
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000 3001
CMD ["node", "dist/internal.js"]
