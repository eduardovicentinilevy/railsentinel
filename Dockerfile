FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig*.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/ingest-gateway/package.json services/ingest-gateway/
COPY services/ats-core/package.json services/ats-core/
COPY services/operator-api/package.json services/operator-api/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# Sem root: um comprometimento no gateway nao deve virar comprometimento do host.
RUN addgroup -S rs && adduser -S rs -G rs
COPY --from=build --chown=rs:rs /app /app
USER rs
ENV NODE_ENV=production
CMD ["node", "services/ingest-gateway/dist/main.js"]
