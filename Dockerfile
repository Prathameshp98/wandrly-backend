# Target < 150 MB: image size affects both build time and cold start on Koyeb.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Run unprivileged; node:alpine ships a `node` user.
RUN chown -R node:node /app
USER node
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node package.json ./
EXPOSE 8000
# Koyeb health-checks /health, which returns 503 until the DB is reachable.
CMD ["node", "dist/server.js"]
