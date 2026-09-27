# One Dockerfile, three targets, built from the repo root:
#
#   docker build -f deploy/Dockerfile --target api  -t skincrm-api  .   # API and worker
#   docker build -f deploy/Dockerfile --target web  -t skincrm-web  .   # Next.js
#   docker build -f deploy/Dockerfile --target tools -t skincrm-tools .  # migrations
#
# Workspace packages ship TypeScript source, so everything builds in one stage
# and the runtime images copy only what they run.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# --- dependencies (cached until a manifest or the lockfile changes) ---------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/connectors/package.json packages/connectors/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/security/package.json packages/security/
RUN pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @skincrm/api build && pnpm --filter @skincrm/web build

# --- tools: migrations and seeds (not a long-running service) -------------
FROM build AS tools
ENV NODE_ENV=production
CMD ["pnpm", "db:migrate"]

# --- api + worker ---------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production
# tsup bundles workspace code; node_modules supplies the external packages
# (fastify, postgres, argon2's native binary…).
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/api/node_modules /repo/apps/api/node_modules
COPY --from=build /repo/apps/api/dist /repo/apps/api/dist
COPY --from=build /repo/apps/api/package.json /repo/apps/api/package.json
COPY --from=build /repo/packages /repo/packages
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
# The worker uses the same image: `command: ["node", "dist/worker.js"]`.
CMD ["node", "dist/main.js"]

# --- web ----------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
