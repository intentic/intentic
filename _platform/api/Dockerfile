# The intentic platform API image (ghcr.io/intentic/api): Hono + oRPC + Better Auth on
# Bun, backed by Postgres via Prisma. Bun executes the TypeScript source directly — the api is never compiled.
#
# Deliberately a pure COPY wrapper: the tree is built and pruned OUTSIDE Docker by the `docker:release` turbo
# task (dependsOn build → workspace deps' dist exist, warm cache; then `pnpm deploy --prod ./deploy` flattens
# the api + its deps — see _tools/scripts/docker-release.sh). The pruned tree IS the build context, so there
# is no .dockerignore and nothing else can leak in:
#   pnpm --filter=@intentic-app/api deploy --prod ./deploy && docker build -f Dockerfile -t …/api ./deploy
#
# Runtime config (see src/config.ts) is injected by the deployment, never baked: DATABASE_URL,
# BETTER_AUTH_SECRET, SECRETS_KEY, WEB_ORIGIN, API_URL, GOOGLE_CLIENT_*, INTENTIC_CLOUDFLARE_*, STRIPE_*, …
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
WORKDIR /app
COPY . /app
# The dev default binds loopback (127.0.0.1); a container must bind all interfaces so the tunnel/proxy
# (a sibling container) reaches it. TLS is terminated at the edge.
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=6480
EXPOSE 6480
# Apply pending migrations, then exec the daemon as PID 1. migrate deploy is idempotent and safe to race
# across replicas (Prisma takes an advisory lock). The CLI is the tree's own prisma (a prod dep, so the prune
# carries it and @prisma/engines — run through bun, the image ships no node); --config resolves the schema +
# migrations relative to the prisma package, and DATABASE_URL comes from the environment.
CMD bun node_modules/prisma/build/index.js migrate deploy --config node_modules/@intentic-app/prisma/prisma.config.ts && exec bun src/main.ts
