# Docker Engine + Compose + buildx for the docker capability's nested engine. The engine stays DORMANT even
# when present: every runner starts the container unprivileged, and dockerd only runs once the docker
# CAPABILITY is added — its handler composes the privileged runtime directive beside this pack into the
# owner-approved overlay (capabilities/handlers/docker.ts; the directive token itself must never appear in a
# pack, even in prose — the rebuild executors grep for it, comments included). Runners mount a named volume at
# /var/lib/docker either way, so images and dev-DB volumes survive recreates — and layers land on a real
# filesystem (overlay2), not the container's own overlayfs.
# The engine and its CLI are pinned, not whatever download.docker.com serves on the day the image is built: two images
# built a day apart otherwise ran different engines with nothing in the diff to say so. Docker's repository keeps every
# past build, so a pin keeps resolving (Debian's own mirrors do not, which is why the Debian packages elsewhere float
# within trixie and take its security updates). containerd.io and the compose/buildx plugins stay unpinned: they are
# released on their own cadence, docker-ce's own dependency floor holds containerd to a version it supports, and a
# pin on each would be three more numbers to move for no difference anyone has hit. The tool bumper
# (_tools/scripts/tools/bump-tools.mjs) moves DOCKER_VERSION once a release has soaked and the repository carries it.
ARG DOCKER_VERSION=29.8.2
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        "docker-ce=5:${DOCKER_VERSION}-1~debian.13~trixie" "docker-ce-cli=5:${DOCKER_VERSION}-1~debian.13~trixie" \
        containerd.io docker-compose-plugin docker-buildx-plugin
