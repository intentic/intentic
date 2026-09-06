# The stand-in model, as a container the journey harness can put on its network beside the platform.
#
# The stock node base with two files copied in, and nothing else: this package has no dependencies and no build
# step, because node 24 runs TypeScript by erasing its types. So there is no prepared tree to stage, no install
# to wait for, and the image builds in about a second on a warm layer cache — which is what makes standing one
# up inside a test cheap enough to do per run.
FROM node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0

# Links the GHCR package to this repository, the same reason dind-host carries it: without it a private package
# is unpullable by the repository's own GITHUB_TOKEN.
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

WORKDIR /app
# `type: module` — main.ts uses top-level await, which node reads as CommonJS without it.
COPY package.json ./package.json
COPY src ./src

# Fixed, because a container is addressed by name and port from outside; the library defaults to 0 instead.
ENV PORT=8099
EXPOSE 8099

# Unprivileged: it serves canned JSON and needs nothing. The base image ships this user.
USER node

CMD ["node", "src/main.ts"]
