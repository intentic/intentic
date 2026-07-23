# The intentic platform API image (registry.gitlab.com/radarsu/intentic/api): Hono + oRPC + Better Auth on
# Bun, backed by Postgres via Prisma. Bun executes the TypeScript source directly — the api is never compiled.
#
# Deliberately a pure COPY wrapper: the tree is built and pruned OUTSIDE Docker by the `docker:release` turbo
# task (dependsOn build → workspace deps' dist exist, warm cache; then `pnpm deploy --prod ./deploy` flattens
# the api + its deps into ./deploy — see _tools/scripts/docker-release.sh). Same philosophy as the sandbox
# image's trees context: job-side builds are cache-warm, so no layer here ever installs or compiles.
#
# The context is THIS app dir (Dockerfile.dockerignore keeps only ./deploy + the entrypoint):
#   pnpm --filter=@intentic-app/api deploy --prod ./deploy && docker build -t …/api _apps/api
#
# Runtime config (see src/config.ts) is injected by the deployment, never baked: DATABASE_URL,
# BETTER_AUTH_SECRET, SECRETS_KEY, WEB_ORIGIN, API_URL, GOOGLE_CLIENT_*, INTENTIC_CLOUDFLARE_*, STRIPE_*, …
FROM oven/bun:1.3.14-slim
LABEL org.opencontainers.image.source=https://gitlab.com/radarsu/intentic
WORKDIR /app
COPY deploy /app
# Migrations then serve. The prisma CLI rides the tree itself (a prod dep, so `pnpm deploy` carries it and the
# schema engine @prisma/engines lays down at prune time) — no separately-pinned global install to drift.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The dev default binds loopback (127.0.0.1); a container must bind all interfaces so the tunnel/proxy
# (a sibling container) reaches it. TLS is terminated at the edge.
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=6480
EXPOSE 6480
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
