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
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
# pg_dump and pg_restore for the pre-migration backup (src/migration-backup.ts), the one thing in this image not COPYed.
# Same major as the server: pg_dump refuses a server newer than itself, and the platform's Postgres is postgres:18
# (_tools/selfhost/platform/docker-compose.yml, and CI's `migrations` job). Moving that image to a new major moves this
# ARG with it, or the next migration stops at its backup. Debian trixie carries only 17, so the client comes from the
# PostgreSQL project's own apt repository (PGDG); its signing key is fetched once and held to a checksum, the key
# B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 that https://www.postgresql.org/download/linux/debian/ publishes.
#
# The two binaries are taken out of the package rather than the package installed: postgresql-client-NN depends on
# postgresql-client-common, whose pg_wrapper is Perl, and that dependency is 60 MB of a 66 MB layer. libpq5 (from the
# same repository, so the same major) is installed properly; `apt-get download` checks the .deb against the signed
# index like an install would.
#
# --chmod because ADD writes a URL's file 0600 and apt reads keyrings as its own unprivileged user; into a directory
# that already exists, because ADD gives the same mode to any directory it creates on the way. The base image
# carries ca-certificates already (Bun's fetch needs it), which is what lets the first apt-get update use https.
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
# Back the database up when migrations are pending, apply them, PROVE THE RESULT IS THE SCHEMA THIS BUILD WAS
# COMPILED AGAINST, then exec the daemon as PID 1.
#
# THE BACKUP COMES FIRST AND A FAILED ONE STOPS THE BOOT. The migration history has no down migrations and several
# that drop or rename, and the old image cannot be run over a migrated database (its own diff below refuses it), so a
# dump taken just before is the only way back from a migration that went wrong. src/migration-backup.ts asks
# `migrate status`; with something pending it pg_dumps into MIGRATION_BACKUP_DIR (the compose file's
# migration-backups volume) and exits non-zero if that fails, unless MIGRATE_WITHOUT_BACKUP=1. With nothing pending
# it does nothing. Restoring: README.md, "Restoring from a pre-migration backup".
#
# migrate deploy is idempotent and safe to race across replicas (Prisma takes an advisory lock). The CLI is the tree's own prisma (a prod dep, so the prune carries it and @prisma/engines — run
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
CMD bun src/migration-backup.ts \
    && bun node_modules/prisma/build/index.js migrate deploy --config node_modules/@intentic/prisma/prisma.config.ts \
    && bun node_modules/prisma/build/index.js migrate diff --from-config-datasource \
        --to-schema node_modules/@intentic/prisma/schema.prisma --exit-code \
        --config node_modules/@intentic/prisma/prisma.config.ts \
    && exec bun src/main.ts
