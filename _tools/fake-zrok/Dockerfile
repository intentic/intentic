# The stand-in tunnel hub, as a container the journey harness can put on its network beside the platform.
#
# The stock node base with two files copied in, and nothing else: this package has no dependencies and no build
# step, because node 24 runs TypeScript by erasing its types. So there is no prepared tree to stage, no install
# to wait for, and the image builds in about a second on a warm layer cache — which is what makes standing one
# up inside a test cheap enough to do per run.
FROM node:24.18.0-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc

# Links the GHCR package to this repository, the same reason dind-host carries it: without it a private package
# is unpullable by the repository's own GITHUB_TOKEN.
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

WORKDIR /app
# `type: module` — main.ts uses top-level await, which node reads as CommonJS without it.
COPY package.json ./package.json
COPY src ./src

# Fixed, because a container is addressed by name and port from outside; the library defaults to 0 instead.
ENV PORT=8098
EXPOSE 8098

# Unprivileged: it serves canned JSON and needs nothing. The base image ships this user.
USER node

CMD ["node", "src/main.ts"]
