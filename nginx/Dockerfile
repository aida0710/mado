# nginx/Dockerfile

# ステージ 1: front を build
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS frontbuild
WORKDIR /front
# About 表示用のコミット情報。.git はビルドコンテキストに無いので host から渡す
# (compose.prod.yaml の build.args → deploy.sh が git から export)。未指定なら 'dev'。
ARG VITE_GIT_COMMIT=""
ARG VITE_GIT_DATE=""
ARG MADO_VERSION=dev
ENV VITE_GIT_COMMIT=$VITE_GIT_COMMIT
ENV VITE_GIT_DATE=$VITE_GIT_DATE
COPY front/package.json front/package-lock.json ./
RUN npm ci
COPY front .
RUN npm run build

# ステージ 2: nginx に静的成果物と設定を焼く
# nginxinc/nginx-unprivileged は default で nginx user (uid 101) として
# 8080/8081 で listen する。port 80 は privileged なので非 root では bind できない。
# 8080はintranet UI、8081はhost TLS proxy専用のOpenLineage入口。
FROM nginxinc/nginx-unprivileged:alpine@sha256:901e944d1f4fc2bd077e8f5568b98c1f6f8cdacf6b97a87747c43134a339b9a7 AS release
ARG MADO_VERSION=dev
ARG VCS_REF=""
ARG BUILD_DATE=""
LABEL org.opencontainers.image.title="Mado Web" \
      org.opencontainers.image.description="Mado web UI and ingress" \
      org.opencontainers.image.source="https://github.com/aida0710/mado" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$MADO_VERSION" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE"
COPY --from=frontbuild /front/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080 8081
