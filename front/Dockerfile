# front/Dockerfile (dev 専用、vite dev を 0.0.0.0 で起動)
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
# TODO(Task 15 / workspaces 解体後): COPY package-lock.json ./ + npm ci に戻す
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npx", "vite", "dev", "--host", "0.0.0.0", "--port", "5173"]
