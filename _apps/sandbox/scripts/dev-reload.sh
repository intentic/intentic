#!/bin/sh
# intentic dev-sandbox FAST reload — recompile the daemon and restart it in place, without rebuilding the image.
#
# This is the inner loop dev-sandbox.sh's bind-mounts make possible: the running container reads /opt/sandbox/dist
# (and each baked workspace package's dist) straight from the working tree, so a source edit needs a TypeScript
# build and a process restart, not `pnpm build:sandbox` + `docker run`. Seconds instead of minutes.
#
# Restart, not signal: the daemon is the container's main process (docker-entrypoint.sh execs it), so restarting
# the container IS restarting the daemon — and it re-runs the entrypoint, which is what the boot path expects.
# Volumes, network, tunnel and env all survive, because the container itself is never recreated.
#
# Falls back with a clear message when the container has no dev mounts (created before they existed): that
# container can only see new code through dev-sandbox.sh, and silently restarting it would look like a no-op.
set -eu

ORIGIN_HOST_PREFIX="intentic-sandbox-"

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required — run this on the machine that runs the sandbox." >&2
    exit 1
fi

# Same single-container detection as dev-sandbox.sh: never guess which sandbox to touch.
matches="$(docker ps --filter "name=^${ORIGIN_HOST_PREFIX}" --format '{{.Names}}' | grep -v -- '-tunnel-' || true)"
count="$(printf '%s\n' "$matches" | grep -c . || true)"
if [ "$count" -eq 0 ]; then
    echo "error: no running sandbox container — run 'sh _apps/sandbox/scripts/dev-sandbox.sh' first." >&2
    exit 1
fi
if [ "$count" -gt 1 ]; then
    echo "error: more than one running sandbox container — refusing to guess which to reload:" >&2
    printf '  %s\n' $matches >&2
    exit 1
fi
CONTAINER="$matches"

# Does this container actually read the working tree? Without the dist mount a restart would just re-run the
# baked code, which reads as "my change did nothing" — the exact confusion this whole path exists to remove.
if ! docker inspect --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' "$CONTAINER" | grep -qx '/opt/sandbox/dist'; then
    echo "error: ${CONTAINER} was created without the dev mounts, so a restart would re-run the baked daemon." >&2
    echo "       Recreate it once with 'sh _apps/sandbox/scripts/dev-sandbox.sh' to enable fast reloads." >&2
    exit 1
fi

# Compile the daemon and every workspace package it depends on, in dependency order. `--filter=@intentic/sandbox...`
# (with the trailing dots) is turbo's "this package AND its dependencies", so a contract change is picked up
# without naming it here.
echo "intentic: compiling the daemon and its workspace deps…"
if ! pnpm turbo run build --filter=@intentic/sandbox...; then
    echo "error: the build failed — the running daemon is untouched. Fix the error and save again." >&2
    exit 1
fi

echo "intentic: restarting ${CONTAINER}…"
docker restart "$CONTAINER" >/dev/null

# Gate on the daemon's own /health, exactly like dev-sandbox.sh: a container that comes back up but crash-loops
# on the new code must not report success. Then on its BOOT: /health answers the moment the process listens,
# while every data route stays parked behind the readiness gate until the chain converges — returning at the
# first 200 reports "reloaded" for a daemon the browser cannot read yet.
echo "intentic: waiting for the daemon…"
tries=0
until docker exec "$CONTAINER" curl -sf http://localhost:8787/health >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
        docker logs --tail 50 "$CONTAINER" >&2 || true
        echo "error: the daemon did not become healthy within 30s (logs above)." >&2
        exit 1
    fi
    sleep 2
done
# A daemon too old to report a boot answers no `"ready":false`, which reads as ready — the old behaviour.
waited=0
while docker exec "$CONTAINER" curl -sf http://localhost:8787/health 2>/dev/null | grep -qF '"ready":false'; do
    waited=$((waited + 1))
    if [ "$waited" -ge 120 ]; then
        echo "intentic: still warming up after 2 minutes — it keeps going in the background."
        break
    fi
    sleep 1
done

echo "intentic: daemon reloaded — docker logs -f ${CONTAINER}"
