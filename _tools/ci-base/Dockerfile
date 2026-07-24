# The CI job image (registry.gitlab.com/radarsu/intentic/ci-base) — every .gitlab-ci.yml job runs in this.
# It exists to delete per-job tool installation: the docker-ce-cli + buildx apt install that the images,
# images:platform and release jobs EACH repeated at runtime, the ripgrep install the test job repeated, and the
# `curl https://bun.sh/install | bash` the release job repeated. Baked once here, all of that becomes free.
#
# GLIBC, deliberately — the base is the node image with tools added, never a docker-cli-alpine image with node
# added. The musl shortcut is actively WRONG for this repo: prepare-image-trees.sh runs `pnpm deploy` on the CI
# host and its node_modules is COPY'd straight into node:24.18.0-bookworm-slim (_apps/sandbox/Dockerfile relies
# on "the registry-prebuilt natives are manylinux — safe as copied"). Under musl, pnpm resolves the musl build
# of sharp/onnxruntime/ast-grep/davey and the glibc sandbox image cannot load them.
#
# Rebuilt by the `ci-base` job in .gitlab-ci.yml, and ONLY when this directory changes.
FROM node:24.18.0

# The docker CLI + buildx plugin (the images/release jobs drive the dind service and export a mode=max buildx
# registry cache) and ripgrep (the iq engine's lexical tier shells into `rg --json`, so the iq test suites need
# it). Same official apt repo the jobs used to add at runtime — resolved once, at image build.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin ripgrep \
    && rm -rf /var/lib/apt/lists/*

# bun — _apps/sync/scripts/build-binaries.sh cross-compiles the release's intentic-sync binaries with
# `bun build --compile`. Copied out of the official image instead of piping the install script from bun.sh: the
# version is pinned, and the build needs no network at this layer. -slim is bookworm, so the binary is linked
# against the same glibc as this image.
# ponytail: keep in lockstep with the oven/bun tag in _apps/api/Dockerfile.
COPY --from=oven/bun:1.3.14-slim /usr/local/bin/bun /usr/local/bin/bun

# pnpm pre-activated at the version package.json pins, so no job pays a corepack fetch on first use. The chmod
# is the node-gyp fix the jobs applied by hand: corepack strips the exec bit off its bundled gyp_main.py, and
# node-pty (which ships no linux prebuild) compiles from source and invokes it directly, otherwise dying with
# "Permission denied". .pnpm-setup keeps its own copy of this — that one covers a packageManager bump landing
# before this image is rebuilt.
# ponytail: bump together with package.json's packageManager field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
    && corepack prepare pnpm@11.13.1 --activate \
    && find "$HOME/.cache/node/corepack" -path '*node-gyp/gyp/gyp_main.py' -exec chmod +x {} +

# Fail the image build, not some pipeline three days later, if any of the baked tooling is missing.
RUN node --version && pnpm --version && docker --version && docker buildx version && bun --version && rg --version
