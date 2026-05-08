# api/Dockerfile
FROM node:22-bookworm-slim

WORKDIR /app

# lzma-native はネイティブビルドが必要 (python3 + make + g++ + bzip2 for tar.bz2 extraction)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ bzip2 \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 非 root (uid 1000) で起動する。node:bookworm-slim に組み込みの `node` ユーザーを利用。
# /app を node 所有にすることで、prod compose の `npm run build` が /app/dist を
# 書き込める。dev compose の bind mount は Docker Desktop の UID 変換で動く。
RUN chown -R node:node /app
USER node

EXPOSE 3000

# port は compose 側で上書き可
CMD ["npx", "tsx", "internal.ts"]
