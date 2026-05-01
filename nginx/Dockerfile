# nginx/Dockerfile

# ステージ 1: front を build
FROM node:22-alpine AS frontbuild
WORKDIR /front
COPY front/package.json front/package-lock.json ./
RUN npm ci
COPY front .
RUN npm run build

# ステージ 2: nginx に静的成果物と設定を焼く
# nginxinc/nginx-unprivileged は default で nginx user (uid 101) として
# 8080 で listen する。port 80 は privileged なので非 root では bind できない。
# host 側で 80:8080 に map する。
FROM nginxinc/nginx-unprivileged:alpine
COPY --from=frontbuild /front/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
