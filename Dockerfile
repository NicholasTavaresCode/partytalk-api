# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
# `npm install` (not `npm ci`) so the build reconciles any transitive deps the
# lock file is missing. Switch back to `npm ci` once package-lock.json is
# regenerated on a machine with full registry access (see README).
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist
# Cloud Run provides PORT (default 8080); main.ts reads it.
EXPOSE 8080
USER node
CMD ["node", "dist/main.js"]