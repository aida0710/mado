# front/Dockerfile (dev 専用、vite dev を 0.0.0.0 で起動)
FROM node:22-alpine

WORKDIR /app

# About のコミット表示用。vite.config が git を呼ぶので git を入れ、
# host から read-only マウントする .git (compose.dev.yaml) を読めるようにする。
# コンテナ root と mount 元 (host uid) の所有者差による dubious ownership を回避。
RUN apk add --no-cache git && git config --system --add safe.directory '*'

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npx", "vite", "dev", "--host", "0.0.0.0", "--port", "5173"]
