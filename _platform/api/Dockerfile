# The intentic platform API image (ghcr.io/intentic/api): Hono + oRPC + Better Auth on
# Bun, backed by Postgres via Prisma. Bun executes the TypeScript source directly — the api is never compiled.
#
# Deliberately a pure COPY wrapper: the tree is built and pruned OUTSIDE Docker by the `docker:release` turbo
# task (dependsOn build → workspace deps' dist exist, warm cache; then `pnpm deploy --prod ./deploy` flattens
# the api + its deps — see _tools/scripts/platform/docker-release.sh). The pruned tree IS the build context, so there
# is no .dockerignore and nothing else can leak in:
#   pnpm --filter=@intentic-app/api deploy --prod ./deploy && docker build -f Dockerfile -t …/api ./deploy
#
# Runtime config (see src/config.ts) is injected by the deployment, never baked: DATABASE_URL,
# BETTER_AUTH_SECRET, SECRETS_KEY, WEB_ORIGIN, API_URL, GOOGLE_CLIENT_*, INTENTIC_CLOUDFLARE_*, STRIPE_*, …
# ponytail: keep in lockstep with _tools/ci-base/Dockerfile and _platform/ingress/Dockerfile — all three
# ship bun 1.4.1 via the same digest-pinned canary-slim until 1.4.1-slim exists on Docker Hub.
FROM oven/bun:canary-slim@sha256:6285dc2ad21f26e6b57f6887905cccccc62f151a6e4b4334faa009a500594b71
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
WORKDIR /app
COPY . /app
# The dev default binds loopback (127.0.0.1); a container must bind all interfaces so the tunnel/proxy
# (a sibling container) reaches it. TLS is terminated at the edge.
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=6480
EXPOSE 6480
# Apply pending migrations, PROVE THE RESULT IS THE SCHEMA THIS BUILD WAS COMPILED AGAINST, then exec the
# daemon as PID 1. migrate deploy is idempotent and safe to race across replicas (Prisma takes an advisory
# lock). The CLI is the tree's own prisma (a prod dep, so the prune carries it and @prisma/engines — run
# through bun, the image ships no node); --config resolves the schema + migrations relative to the prisma
# package, and DATABASE_URL comes from the environment.
#
# THE MIDDLE STEP IS NOT BELT AND BRACES. `migrate deploy` reports success on the strength of the migration
# NAMES recorded in _prisma_migrations and nothing else — it does not read the columns, and it does not notice
# that a migration's file changed after it ran. When `challenge` was added by editing a migration this database
# had already applied, deploy printed "No pending migrations to apply" and the API started against a table
# missing a column the client believed in; every desktop sign-in threw an unhandled 500 for a week, and the
# only place that fact existed was a postgres log line. Comparing the live database to the datamodel is the
# question deploy is not asking. --exit-code makes an actual difference exit 2, so `&&` stops here.
#
# It stops the container, deliberately. An API whose database does not match the schema it was built against is
# not a degraded API, it is one that answers some fraction of its routes with a 500 and cannot say which — and
# a container that refuses to start is visible in minutes, which is the entire difference from what happened.
# CI holds the other end (the `migrations` job in ci.yml): a build whose migrations do not replay into
# schema.prisma never becomes an image, so anything this finds is drift in the DATABASE, not in the release.
CMD bun node_modules/prisma/build/index.js migrate deploy --config node_modules/@intentic-app/prisma/prisma.config.ts \
    && bun node_modules/prisma/build/index.js migrate diff --from-config-datasource \
        --to-schema node_modules/@intentic-app/prisma/schema.prisma --exit-code \
        --config node_modules/@intentic-app/prisma/prisma.config.ts \
    && exec bun src/main.ts
