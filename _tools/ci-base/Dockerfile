# The CI job image (ghcr.io/intentic/ci-base) — every CI job runs in this.
# It exists to delete per-job tool installation: the docker-ce-cli + buildx apt install that the images,
# images-platform and release jobs EACH repeated at runtime, the ripgrep install the test job repeated, and the
# `curl https://bun.sh/install | bash` the release job repeated. Baked once here, all of that becomes free.
#
# The base is the SAME digest-pinned image the sandbox runtime uses (_sandbox/sandbox/Dockerfile) — deliberately,
# not coincidentally. prepare-image-trees.sh runs `pnpm deploy` in THIS image and the resulting node_modules is
# COPY'd into THAT one, so sharing a base makes the compiled natives (node-pty, @discordjs/opus) and the
# manylinux prebuilts (sharp, onnxruntime, ast-grep, davey) glibc-identical by construction. It also rules out
# the tempting shortcut of a docker-cli-alpine base with node bolted on: under musl, pnpm resolves musl builds
# of those prebuilts and the glibc sandbox cannot load them.
# ponytail: bump this digest together with _sandbox/sandbox/Dockerfile's FROM — they must stay identical.
FROM node:24.18.0-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc

# What LINKS the GHCR package to this repository, and the reason is not cosmetic: an unlinked private package
# is one the repository's own GITHUB_TOKEN cannot pull, so every job that runs in this image dies at
# `Error response from daemon: denied` before its first step. That is exactly how the first Actions run failed.
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

# Everything the jobs actually need, and nothing else — the full `node:24.18.0` image would supply most of this
# but costs ~1.2GB more for a pile of toolchains no job invokes.
#   ca-certificates + curl  fetch the docker apt key below; curl also backs assorted script steps
#   git                     turbo hashes inputs through `git ls-files`, and semantic-release drives git directly
#   python3 make g++        the node-gyp toolchain: node-pty ships no linux prebuild, so `pnpm install` ALWAYS
#                           compiles it from source (this is also why .pnpm-setup carries the gyp_main.py chmod)
#   ripgrep                 the iq engine's lexical tier shells into `rg --json`, so the iq suites need it
#   openssh-client          sandbox git access generates its ed25519 key with ssh-keygen, so that suite needs it
#   tmux                    the agent's shell-busy probe reads one tmux behaviour and nothing else (a window
#                           whose command exited stays listed as a DEAD pane), so agent-terminals.integration
#                           runs against a REAL private tmux server — stub it and the test asserts the stub
#   docker-ce-cli + buildx  the images/release jobs drive the dind service and export a mode=max registry cache
# The docker apt repo is added the same way _sandbox/sandbox/Dockerfile adds it; resolved once, here, instead of in
# three jobs at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ ripgrep openssh-client tmux \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# Git's ownership check, switched off for every repository this image is handed. The runner's workspace belongs
# to the host's runner user and a job container runs as root, so git calls the checkout "dubious ownership" and
# refuses it — exit 128, before it reads a single object. actions/checkout hides this rather than hitting it:
# it writes its own safe.directory into a HOME it overrides FOR ITS OWN STEPS, so the checkout succeeds and
# every later step in the job inherits a git that will not touch the tree it just cloned.
# What that cost: semantic-release probes for a repository with stderr discarded, so the refusal surfaced as
# `ENOGITREPO Not running from a git repository` and failed the release step of every pipeline. `git ls-files`
# — how turbo hashes task inputs — is behind the same wall in every other job, silently.
# `*` and not the workspace path: an exact path is the only other form git honours (a `/__w/*` glob is NOT
# matched), and baking one repository's checkout path into a shared CI image is the worse trade.
RUN git config --system --add safe.directory '*'

# bun — _sandbox/sync/scripts/build-binaries.sh cross-compiles the release's intentic-sync binaries with
# `bun build --compile`. Copied out of the official image instead of piping the install script from bun.sh: the
# version is digest-pinned and this layer needs no network. -slim is bookworm, so the binary is linked against
# the same glibc as this image.
# ponytail: keep in lockstep with the oven/bun tag in _platform/api/Dockerfile.
COPY --from=oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 /usr/local/bin/bun /usr/local/bin/bun

# pnpm pre-activated at the version package.json pins, so no job pays a corepack fetch on first use. The chmod
# is the node-gyp fix the jobs applied by hand: corepack strips the exec bit off its bundled gyp_main.py, and
# node-pty compiles from source and invokes it directly, otherwise dying with "Permission denied". .pnpm-setup
# keeps its own copy of this — that one covers a packageManager bump landing before this image is rebuilt.
# ponytail: bump together with package.json's packageManager field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
    && corepack prepare pnpm@11.13.1 --activate \
    && find "$HOME/.cache/node/corepack" -path '*node-gyp/gyp/gyp_main.py' -exec chmod +x {} +

# Fail the image build, not some pipeline three days later, if any of the baked tooling is missing.
RUN node --version && pnpm --version && git --version && docker --version && docker buildx version \
    && bun --version && rg --version && tmux -V && python3 --version && make --version | head -1 && g++ --version | head -1 \
    && command -v ssh-keygen
