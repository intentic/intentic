# The intentic ingress image (ghcr.io/intentic/ingress): the edge every sandbox is reached through. Bun
# executes the TypeScript source directly — like the api, this is never compiled.
#
# Deliberately a pure COPY wrapper, the same shape as _platform/api/Dockerfile: the tree is built and pruned
# OUTSIDE Docker by the `docker:release` turbo task (dependsOn build → workspace deps' dist exist, warm cache;
# then `pnpm deploy --prod ./deploy` flattens this app + its deps — see _tools/scripts/docker-release.sh). The
# pruned tree IS the build context, so there is no .dockerignore and nothing else can leak in.
#
# THERE IS NO BOOT CHAIN HERE, and the contrast with the api's is the point: no migrations to apply, no schema
# to prove, no database to reach. The process holds live connections and nothing else, so "started" and "ready"
# are the same moment — which is also what makes it safe to redeploy at any time and what makes "add another
# machine" the whole of the scaling story. A restart drops every registration; every container redials inside
# its own backoff.
#
# Runtime config (see src/config.ts) is injected by the deployment, never baked:
#   INGRESS_PUBLIC_KEY  the platform's Ed25519 PUBLIC key (SPKI PEM). Required — the process exits without it.
#   PLATFORM_URL        where to ask whether a sandbox still exists. Unset ⇒ that check is off.
#   INGRESS_PORT/HOST   defaults 8080 / 0.0.0.0.
# The private half NEVER appears here: this image can verify grants and can never mint one, which is the whole
# of why a compromised edge cannot make anything reachable.
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
WORKDIR /app
COPY . /app
ENV NODE_ENV=production INGRESS_HOST=0.0.0.0 INGRESS_PORT=8080
EXPOSE 8080
CMD ["bun", "src/main.ts"]
