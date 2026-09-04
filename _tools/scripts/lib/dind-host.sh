#!/usr/bin/env bash
# A CLEAN DOCKER HOST TO RUN A USER'S SETUP ON — the twenty-five lines both nightly drills opened with.
#
#   . "$(dirname "$0")/../lib/repo-root.sh"        # required: the build context is found from the repo root
#   . "$(dirname "$0")/../lib/dind-host.sh"
#   start_dind_host intentic-desktop-setup-smoke
#   in_host docker ps
#
# WHY A CONTAINER AND NOT THE RUNNER'S OWN DAEMON. Both tiers that use this are about what happens on a machine
# that has never seen intentic: connect.sh pulling an image, standing a container up, wiring a network, waiting
# on /health. Run against the runner's daemon that is a test of a machine with six other jobs' containers on
# it, and it leaves them behind. _tools/dind-host is the same Docker-in-Docker + sshd recipe the deployment e2e
# uses, so this stays in lockstep with it rather than carrying a second copy.
#
# WHAT THE CALLER STILL OWNS: the trap. The two callers clean up differently (one has a work directory, one has
# a sandbox container inside the host as well), and a cleanup written in here would either be wrong for one of
# them or would have to grow a registry of things to remove.

# Start one and wait for its daemon. `$1` is the container name — chosen by the caller, because two tiers
# running at once on the same runner must not claim each other's.
#
# Defines `in_host` for the caller: everything after this runs INSIDE the host, and spelling `docker exec
# "$HOST_CONTAINER"` at each call site is how the two copies of this drifted in the first place.
start_dind_host() {
    DIND_CONTAINER="${1:?start_dind_host: a container name is required}"

    echo "==> starting a clean Docker host"
    local image="${INTENTIC_HOST_IMAGE:-}"
    if [ -z "$image" ]; then
        image="intentic-dind-host:local"
        docker build -q -t "$image" "$(repo_root)/_tools/dind-host" >/dev/null
    fi
    # --privileged + empty DOCKER_TLS_CERTDIR: the dind entrypoint's own contract (see _tools/dind-host).
    docker run -d --rm --name "$DIND_CONTAINER" --privileged -e DOCKER_TLS_CERTDIR="" "$image" >/dev/null

    echo -n "    waiting for the daemon"
    local _
    for _ in $(seq 1 60); do
        if in_host docker info >/dev/null 2>&1; then break; fi
        echo -n "."
        sleep 1
    done
    echo
    if ! in_host docker info >/dev/null 2>&1; then
        echo "error: the Docker daemon inside the host never came up" >&2
        docker logs "$DIND_CONTAINER" >&2 || true
        exit 1
    fi

    # connect.sh refuses to start without curl (it would otherwise die mid-run on a raw "command not found");
    # the dind image is Alpine and ships only busybox wget. Installed here rather than baked into dind-host,
    # which keeps that image exactly what the deployment e2e needs it to be.
    in_host apk add --no-cache curl >/dev/null 2>&1

    # connect.sh pulls its image with the host's OWN daemon, which starts credential-less. A user's machine
    # needs none — the shipped image is public — but CI points SANDBOX_E2E_IMAGE at the private ghcr package,
    # so hand the runner's registry login (docker/login-action's config.json) through when one exists.
    if [ -f "$HOME/.docker/config.json" ]; then
        in_host mkdir -p /root/.docker
        docker cp "$HOME/.docker/config.json" "$DIND_CONTAINER:/root/.docker/config.json"
    fi
}

# Run a command inside the host started above.
in_host() {
    docker exec "${DIND_CONTAINER:?in_host: call start_dind_host first}" "$@"
}
