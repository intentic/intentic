# Shared CI tools. Keep this base digest identical to _sandbox/sandbox/Dockerfile: pnpm-deployed native modules run in that image.
# Do not substitute musl/Alpine: its resolved native dependencies cannot load in the glibc sandbox.
# ci-desktop inherits this base; when changing Debian releases, update _tools/desktop-smoke/Dockerfile to match.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# What LINKS the GHCR package to this repository, and the reason is not cosmetic: an unlinked private package
# is one the repository's own GITHUB_TOKEN cannot pull, so every job that runs in this image dies at
# `Error response from daemon: denied` before its first step. That is exactly how the first Actions run failed.
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

# Tools required by jobs and integration tests, including real tmux/procps/bwrap behavior and fileq/privacy document rendering.
# Keep the slim Node base plus explicit packages instead of the full image's unused toolchains.
# Install Docker CLI/buildx from the same apt source as the sandbox Docker pack, avoiding per-job installation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq git python3 make g++ ripgrep openssh-client tmux zip unzip procps zstd bubblewrap \
        poppler-utils fonts-dejavu-core python3-pil \
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

# The privacy shield's text reader: PaddleOCR's PP-OCRv6 medium detector and recognizer, the ONNX files the privacy
# image pack installs, at the same path, so _sandbox/ocr and the shield's image masking are proved against the real models
# rather than a stand-in (~132 MB, a few seconds of build). onnxruntime-node itself comes with the workspace's install.
# ponytail: keep the revisions and digests in lockstep with _sandbox/sandbox/image-packs/privacy.Dockerfile
# (packs.integration.test.ts holds the two in step).
# Placed above bun, ruff/pyright and pnpm, whose pins the daily tool bump moves: these models move only with the
# privacy pack, so a tool bump no longer re-downloads them and every runner keeps the 132 MB layer it already pulled.
RUN ocr=/opt/privacy-models/pp-ocrv6 \
    && mkdir -p "$ocr/det" "$ocr/rec" \
    && det="https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/61323801669c338b7891481ec7bac61ce31b576a" \
    && rec="https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/50c7eacafc52fa7bcf4194e8cd08e46f8558504b" \
    && curl -fsSL --retry 3 -o "$ocr/det/inference.onnx" "$det/inference.onnx" \
    && curl -fsSL --retry 3 -o "$ocr/det/inference.yml" "$det/inference.yml" \
    && curl -fsSL --retry 3 -o "$ocr/rec/inference.onnx" "$rec/inference.onnx" \
    && curl -fsSL --retry 3 -o "$ocr/rec/inference.yml" "$rec/inference.yml" \
    && printf '%s  %s\n' \
        eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1 "$ocr/det/inference.onnx" \
        7298d5ead546584af2504d03355f881ac7a7bc0eb1e282d3e159277c1d0af871 "$ocr/det/inference.yml" \
        9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba "$ocr/rec/inference.onnx" \
        991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129 "$ocr/rec/inference.yml" \
        | sha256sum -c -

# bun — _tools/scripts/build/build-agent-binaries.sh cross-compiles the release's intentic-machine binaries with
# `bun build --compile`. Copied out of the official image instead of piping the install script from bun.sh: the
# version is digest-pinned and this layer needs no network. -slim is Debian trixie, so the binary is linked against
# a glibc this image satisfies.
# The pin is one of _tools/scripts/tools/tool-pins.mjs's, moved with the sandbox image's, the platform api's and the
# `bun` catalog entry's by the tool bump; the `tool-pins` check refuses a hand edit that moves only some of them.
COPY --from=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 /usr/local/bin/bun /usr/local/bin/bun

# ruff and pyright, the two binaries the daemon's python check runs on every `.py` edit
# (_sandbox/sandbox/src/agent/verification/python/python-diagnostics.ts). Its integration suite spawns the real ones,
# because only that proves the parsers read what the binaries print, and pyright's `--outputjson` is a wire format.
# So CI runs the SAME versions the sandbox image ships, fetched the same way (~62 MB, ~6s of build).
# ponytail: keep both versions in lockstep with _sandbox/sandbox/image-packs/python.Dockerfile.
RUN ruff_version=0.17.2 \
    && case "$(dpkg --print-architecture)" in \
        amd64) triple=x86_64-unknown-linux-gnu ;; \
        arm64) triple=aarch64-unknown-linux-gnu ;; \
        *) echo "ci-base: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/astral-sh/ruff/releases/download/${ruff_version}/ruff-${triple}.tar.gz" \
        | tar -xz -C /usr/local/bin --strip-components=1 "ruff-${triple}/ruff" \
    && npm install -g pyright@1.1.414 \
    && npm cache clean --force

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
RUN curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.15.0 SHELL=/bin/sh ENV=/tmp/pnpm-env.sh sh - \
    && rm -f /tmp/pnpm-env.sh \
    && pnpm --version

# Fail the image build, not some pipeline three days later, if any of the baked tooling is missing.
RUN node --version && pnpm --version && git --version && docker --version && docker buildx version \
    && bun --version && jq --version && rg --version && tmux -V && python3 --version && make --version | head -1 && g++ --version | head -1 \
    && command -v ssh-keygen && command -v zip && command -v unzip && command -v tar && command -v gzip && command -v zstdcat \
    && pdftoppm -v && test -f /opt/privacy-models/pp-ocrv6/rec/inference.onnx \
    && test -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf && python3 -c 'import PIL' \
    && ruff --version && pyright --version
