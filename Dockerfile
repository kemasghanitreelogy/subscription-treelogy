# Satu image untuk dua process Fly (web + worker) — lihat fly.toml [processes].
FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY extensions/customer-account-portal/package.json ./extensions/customer-account-portal/

# Dev deps ikut ter-install karena build (vite) & worker (tsx) membutuhkannya.
RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build

# web: migrasi lalu serve (docker-start). worker: npm run worker.
CMD ["npm", "run", "docker-start"]
