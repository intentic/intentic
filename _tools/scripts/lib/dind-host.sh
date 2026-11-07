#!/usr/bin/env bash
# Shared clean Docker-in-Docker host for setup/update drills; using the runner daemon would couple them to other jobs' containers.
# Source repo-root.sh first, then call start_dind_host <name> and in_host <command> against _tools/dind-host.
# Callers own cleanup traps because their work directories and nested sandbox cleanup differ.

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
    # It reaches Alpine's mirror, so it is retried through a short outage, and what apk said is shown when it never
    # gets through: discarded, a runner with no route out ended the drill on a bare exit 1 (run 42359893687).
    local attempt apk_output
    for attempt in 1 2 3 4 5; do
        if apk_output="$(in_host apk add --no-cache curl 2>&1)"; then break; fi
        if [ "$attempt" -eq 5 ]; then
            echo "error: the Docker host could not install curl from Alpine's mirror:" >&2
            echo "$apk_output" >&2
            exit 1
        fi
        echo "    apk add curl failed (attempt $attempt/5); retrying in $((attempt * 5))s"
        sleep "$((attempt * 5))"
    done

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
