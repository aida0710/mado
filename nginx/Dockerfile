# nginx/Dockerfile

# ステージ 1: front を build
FROM node:22-alpine AS frontbuild
WORKDIR /app
# root package.json (workspaces: typescript はここに入っている)
COPY package.json ./
# front の package.json をワークスペースパスに配置
COPY front/package.json ./front/
# TODO(Task 15 / workspaces 解体後): COPY package-lock.json ./ + npm ci に戻す
# ワークスペースルートから install することで typescript 等が解決される
RUN npm install --workspace front --include-workspace-root
COPY front ./front
RUN cd front && npm run build

# ステージ 2: nginx に静的成果物と設定を焼く
FROM nginx:alpine
COPY --from=frontbuild /app/front/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
