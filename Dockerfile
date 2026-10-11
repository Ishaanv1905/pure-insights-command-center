# Multi-stage build: stage 1 builds the React app, stage 2 is a slim runtime
# with only production dependencies. The Express server serves the built UI,
# so the whole product runs on one port.

FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev
COPY server/ ./server/
COPY feeder/ ./feeder/
COPY data/ ./data/
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p /app/storage && chown node:node /app/storage
ENV DATABASE_PATH=/app/storage/pure-insights.db
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/server.js"]
