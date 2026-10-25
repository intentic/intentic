# The intentic platform API image (ghcr.io/intentic/api): Hono + oRPC + Better Auth on
# Bun, backed by Postgres via Prisma. Bun executes the TypeScript source directly — the api is never compiled.
#
# Deliberately a COPY wrapper, save the Postgres client below: the tree is built and pruned OUTSIDE Docker by the `docker:release` turbo
# task (dependsOn build → workspace deps' dist exist, warm cache; then `pnpm deploy --prod` flattens the api + its
# deps into a temporary directory outside the repository — see _tools/scripts/platform/docker-release.sh). The pruned
# tree IS the build context, so there is no .dockerignore and nothing else can leak in:
#   pnpm --filter=@intentic/api deploy --prod "$tree" && docker build -f Dockerfile -t …/api "$tree"
#
# Runtime config (see src/config.ts) is injected by the deployment, never baked: DATABASE_URL,
# BETTER_AUTH_SECRET, SECRETS_KEY, WEB_ORIGIN, API_URL, GOOGLE_CLIENT_*, INTENTIC_CLOUDFLARE_*, STRIPE_*, …
# The Bun pin is one of _tools/scripts/tools/tool-pins.mjs's, moved with CI's, the sandbox image's and the `bun`
# catalog entry's by the tool bump; the `tool-pins` check refuses a hand edit that moves only some of them.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
# Match PostgreSQL clients to the server major: pg_dump refuses newer servers, so bump this ARG with the platform database image.
# Extract client binaries to avoid Perl pg_wrapper's dependency cost; install libpq from the same signed PGDG repository.
# Keep the downloaded key and its existing directory readable by apt: URL ADD defaults to 0600 unless --chmod overrides it.
ARG POSTGRES_MAJOR=18
ADD --chmod=644 --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc /etc/apt/keyrings/postgresql.asc
RUN echo "deb [signed-by=/etc/apt/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && cd /tmp \
    && apt-get download "postgresql-client-${POSTGRES_MAJOR}" \
    && dpkg-deb -x postgresql-client-"${POSTGRES_MAJOR}"_*.deb /tmp/pgclient \
    && install -m 0755 -t /usr/local/bin \
        "/tmp/pgclient/usr/lib/postgresql/${POSTGRES_MAJOR}/bin/pg_dump" "/tmp/pgclient/usr/lib/postgresql/${POSTGRES_MAJOR}/bin/pg_restore" \
    && rm -rf /tmp/pgclient /tmp/*.deb /var/lib/apt/lists/* \
    && pg_dump --version \
    && pg_restore --version
WORKDIR /app
COPY . /app
# The dev default binds loopback (127.0.0.1); a container must bind all interfaces so the tunnel/proxy
# (a sibling container) reaches it. TLS is terminated at the edge.
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=6480
EXPOSE 6480
# Before boot: back up pending migrations, deploy them, verify live schema against this build, then exec the daemon as PID 1.
# Backup failure stops boot unless MIGRATE_WITHOUT_BACKUP=1; README.md documents restoring the pre-migration dump.
# Prisma's advisory lock permits replica races, but migration-name bookkeeping alone misses changed applied SQL and database drift.
# Keep the --exit-code schema diff in the && chain so mismatches stop boot; use the production Prisma CLI through Bun.
CMD bun src/migration-backup.ts \
    && bun node_modules/prisma/build/index.js migrate deploy --config node_modules/@intentic/prisma/prisma.config.ts \
    && bun node_modules/prisma/build/index.js migrate diff --from-config-datasource \
        --to-schema node_modules/@intentic/prisma/schema.prisma --exit-code \
        --config node_modules/@intentic/prisma/prisma.config.ts \
    && exec bun src/main.ts
