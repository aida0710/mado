# nginx/Dockerfile

# ステージ 1: front を build
FROM node:22-alpine AS frontbuild
WORKDIR /front
COPY front/package.json front/package-lock.json ./
RUN npm ci
COPY front .
RUN npm run build

# ステージ 2: nginx に静的成果物と設定を焼く
FROM nginx:alpine
COPY --from=frontbuild /front/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
