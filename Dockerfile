# syntax=docker/dockerfile:1.7
# One image: the guard API plus the built dashboard, served from the same origin.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/guard/package.json apps/guard/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/demo-agent/package.json apps/demo-agent/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN npm ci --no-audit --no-fund
COPY apps/guard apps/guard
COPY apps/dashboard apps/dashboard
RUN npm run build -w apps/dashboard && npm run build -w apps/guard

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/guard/package.json apps/guard/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/demo-agent/package.json apps/demo-agent/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/public
WORKDIR /app/apps/guard
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/apps/guard/dist ./dist
COPY --from=build /app/apps/guard/package.json ./package.json
COPY apps/guard/migrations ./migrations
COPY --from=build /app/apps/dashboard/dist /app/public
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/server.js"]
