# The CI job image (ghcr.io/intentic/ci-base) — every CI job runs in this.
# It exists to delete per-job tool installation: the docker-ce-cli + buildx apt install that the images,
# images-platform and release jobs EACH repeated at runtime, the ripgrep install the test job repeated, and the
# `curl https://bun.sh/install | bash` the release job repeated. Baked once here, all of that becomes free.
#
# The base is the SAME digest-pinned image the sandbox runtime uses (_sandbox/sandbox/Dockerfile) — deliberately,
# not coincidentally. prepare-image-trees.sh runs `pnpm deploy` in THIS image and the resulting node_modules is
# COPY'd into THAT one, so sharing a base makes the manylinux prebuilts (sharp, onnxruntime, ast-grep, davey,
# mediaplex) glibc-identical by construction. It also rules out
# the tempting shortcut of a docker-cli-alpine base with node bolted on: under musl, pnpm resolves musl builds
# of those prebuilts and the glibc sandbox cannot load them.
#
# AND THE DEBIAN RELEASE IS WHAT THE DESKTOP BINARY IS LINKED AGAINST. ci-desktop builds on this image, so the
# .deb and the AppImage that come out ask for whatever glibc this base ships (trixie: 2.41, and the binary
# asks for GLIBC_2.39). _tools/desktop-smoke/Dockerfile is the host they are then installed and RUN on, and it
# was left on bookworm when this moved to trixie — desktop-verify died in the loader on every artifact, twice
# per run, on a build that was otherwise correct (run 34046947138). A smoke host older than this base does not
# test an older user's machine; it tests a machine the artifact was never built for.
# ponytail: bump this digest together with _sandbox/sandbox/Dockerfile's FROM — they must stay identical — and
# move _tools/desktop-smoke/Dockerfile's FROM to the same Debian release.
FROM node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590

# What LINKS the GHCR package to this repository, and the reason is not cosmetic: an unlinked private package
# is one the repository's own GITHUB_TOKEN cannot pull, so every job that runs in this image dies at
# `Error response from daemon: denied` before its first step. That is exactly how the first Actions run failed.
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

# Everything the jobs actually need, and nothing else — the full `node:24.21.0` image would supply most of this
# but costs ~1.2GB more for a pile of toolchains no job invokes.
#   ca-certificates + curl  fetch the docker apt key below; curl also backs assorted script steps
#   git                     turbo hashes inputs through `git ls-files`, and semantic-release drives git directly
#   python3 make g++        the node-gyp toolchain, for a native dep that ships no prebuild for this platform
#   ripgrep                 the iq engine's lexical tier shells into `rg --json`, so the iq suites need it
#   openssh-client          sandbox git access generates its ed25519 key with ssh-keygen, so that suite needs it
#   zip + unzip             the workspace's Extract route spawns unzip, and its suite builds the fixtures with
#                           zip; the sandbox runtime installs the same pair (tar and gzip come with the base)
#   tmux                    the agent's shell-busy probe reads one tmux behaviour and nothing else (a window
#                           whose command exited stays listed as a DEAD pane), so agent-terminals.integration
#                           runs against a REAL private tmux server — stub it and the test asserts the stub
#   procps                  the self-kill guard rewrites pkill/pgrep patterns, and agent-terminals.integration
#                           proves the rewrite with a real pgrep; the sandbox runtime installs the same package
#   docker-ce-cli + buildx  the images/release jobs drive the dind service and export a mode=max registry cache
# The docker apt repo is added the same way the sandbox's docker feature pack adds it
# (_sandbox/sandbox/image-packs/docker.Dockerfile); resolved once, here, instead of in three jobs at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ ripgrep openssh-client tmux zip unzip procps \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list \
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

# bun — _tools/scripts/build/build-agent-binaries.sh cross-compiles the release's intentic-machine binaries with
# `bun build --compile`. Copied out of the official image instead of piping the install script from bun.sh: the
# version is digest-pinned and this layer needs no network. -slim is Debian, and an older one than this image's
# trixie, so the binary is linked against a glibc this one already satisfies.
# ponytail: keep in lockstep with _platform/api/Dockerfile and _platform/ingress/Dockerfile — all three
# ship bun 1.4.1 via the same digest-pinned canary-slim until 1.4.1-slim exists on Docker Hub.
COPY --from=oven/bun:canary-slim@sha256:6285dc2ad21f26e6b57f6887905cccccc62f151a6e4b4334faa009a500594b71 /usr/local/bin/bun /usr/local/bin/bun

# pnpm INSTALLED NATIVELY, not through corepack, because pnpm 12 already does corepack's job: it is a Rust
# binary that needs no Node, and `pmOnFail` defaults to `download`, so it fetches whatever version the
# `packageManager` field names. Running corepack in front of that pinned the same version twice.
# What the second copy cost: corepack reads a version directory as "installed" and execs the pnpm.mjs inside it
# without looking first, so a HALF-WRITTEN cache was fatal and sticky — every job landing on that runner died
# on a MODULE_NOT_FOUND until someone cleared it by hand, once for 15 minutes. The chmod beside it repaired an
# exec bit corepack itself stripped off its bundled node-gyp, which a source-built native dep invokes
# directly. Neither failure mode has a path to reach any more, and .pnpm-setup's copies of both are gone with
# them.
# ponytail: bump together with package.json's packageManager field.
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PATH
RUN curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.4.1 SHELL=/bin/sh ENV=/tmp/pnpm-env.sh sh - \
    && rm -f /tmp/pnpm-env.sh \
    && pnpm --version

# Fail the image build, not some pipeline three days later, if any of the baked tooling is missing.
RUN node --version && pnpm --version && git --version && docker --version && docker buildx version \
    && bun --version && rg --version && tmux -V && python3 --version && make --version | head -1 && g++ --version | head -1 \
    && command -v ssh-keygen && command -v zip && command -v unzip && command -v tar && command -v gzip
