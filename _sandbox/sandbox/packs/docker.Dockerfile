# Docker Engine + Compose + buildx for the docker capability's nested engine. The engine stays DORMANT even
# when present: every runner starts the container unprivileged, and dockerd only runs once the docker
# CAPABILITY is added — its handler composes the privileged runtime directive beside this pack into the
# owner-approved overlay (capabilities/handlers/docker.ts; the directive token itself must never appear in a
# pack, even in prose — the rebuild executors grep for it, comments included). Runners mount a named volume at
# /var/lib/docker either way, so images and dev-DB volumes survive recreates — and layers land on a real
# filesystem (overlay2), not the container's own overlayfs.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
