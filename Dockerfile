# syntax=docker/dockerfile:1
# Quizly in one image: the API and the client on port 3000. It needs a
# Postgres (DATABASE_URL), ADMIN_PASSWORD and SESSION_SECRET, and brings the
# schema up to date as it starts. See "Running it in a container" in the README.
FROM node:22-alpine

# Fixes the distribution has published and the base image has not picked up yet.
RUN apk upgrade --no-cache

WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY client ./client
COPY shared ./shared
# `node scripts/seed.js` imports the sample quiz; `node scripts/migrate.js` runs the migrations alone.
COPY data ./data
COPY scripts/migrate.js scripts/seed.js ./scripts/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# server/index.js is a small supervisor that holds the port and runs the app in
# a worker: SIGTERM stops it without making screens wait, SIGHUP reloads it in place.
CMD ["node", "server/index.js"]
