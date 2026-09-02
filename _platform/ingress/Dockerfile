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
# BUN CANARY, PINNED BY DIGEST, AND THE ONE REASON IT IS NOT A RELEASED TAG: the edge asks the platform
# whether a sandbox still exists BEFORE it upgrades the WebSocket (that round trip is the whole of
# revocation), so `handleUpgrade` always runs a tick or more after the `upgrade` event. Every RELEASED bun
# — 1.4.0 is the newest, 2026-08-20 — aborts that handshake and then dies inside its own abort path
# (`abortHandshake` reads STATUS_CODES off an http shim that does not have it), so the first sandbox to
# register a tunnel killed this process and it restarted into the same crash on the retry. Measured: an
# upgrade 0ms after the event succeeds, 5ms crashes, and node does it at any delay.
#
# Bun's main fixed it (the runtime smoke in scripts/ passes on 1.4.1 and fails on 1.4.0), so this rides
# canary rather than moving the edge off bun. The digest pin is what keeps that reproducible — `canary` is a
# moving tag and an unpinned one would silently change the runtime under a process that holds every
# sandbox's tunnel. MOVE THIS TO `1.4.1-slim` (and the bun devDependency in package.json with it) as soon as
# 1.4.1 is released; both exist only to wait that release out.
FROM oven/bun:canary-slim@sha256:6285dc2ad21f26e6b57f6887905cccccc62f151a6e4b4334faa009a500594b71
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
WORKDIR /app
COPY . /app
ENV NODE_ENV=production INGRESS_HOST=0.0.0.0 INGRESS_PORT=8080
EXPOSE 8080
CMD ["bun", "src/main.ts"]
