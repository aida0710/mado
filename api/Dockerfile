# api/Dockerfile
FROM node:22-bookworm-slim

WORKDIR /app

# lzma-native はネイティブビルドが必要 (python3 + make + g++ + bzip2 for tar.bz2 extraction)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ bzip2 \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# TODO(Task 15 / workspaces 解体後): COPY package-lock.json ./ + npm ci に戻す
RUN npm install

COPY . .

EXPOSE 3000 3001

# entry / port は compose 側で上書き
CMD ["npx", "tsx", "internal.ts"]
