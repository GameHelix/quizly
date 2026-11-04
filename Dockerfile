# syntax=docker/dockerfile:1
# Quizly in one image: the API and the client on port 3000. It needs a
# Postgres (DATABASE_URL), ADMIN_PASSWORD and SESSION_SECRET, and brings the
# schema up to date as it starts. See "Running it in a container" in the README.
FROM node:22-alpine

# Fixes the distribution has published and the base image has not picked up
# yet; tini, so that something reaps what a health check leaves behind and
# passes every signal on to the app.
RUN apk upgrade --no-cache && apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Owned by the user the app runs as, so a checkout made under a strict umask still reads.
COPY --chown=node:node server ./server
COPY --chown=node:node client ./client
COPY --chown=node:node shared ./shared
# `node scripts/seed.js` imports the sample quiz; `node scripts/migrate.js` runs the migrations alone.
COPY --chown=node:node data ./data
COPY --chown=node:node scripts/migrate.js scripts/seed.js ./scripts/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# server/index.js is a small supervisor that runs the app in a worker:
# SIGTERM stops it without making screens wait, SIGHUP reloads it in place.
CMD ["node", "server/index.js"]
