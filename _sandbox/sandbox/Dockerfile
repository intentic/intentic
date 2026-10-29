# Core daemon/workspace image; image-packs/profiles.json adds the same fragments used by on-demand environment overlays.
# prepare-image-trees.sh builds/prunes packages outside Docker and supplies the named trees context; build from the repository root.
# compose-image-dockerfile.mjs splices profile packs at the markers below and stamps /opt/packs so the daemon can detect them.
# Runtime mounts /work; provider credentials are created inside the running sandbox and must never enter this image.

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS runtime
# Links the GHCR package to the repo (inherits its visibility/permissions, shows under its Packages).
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

# THE BUILD-CACHE CONTRACT, set once here and relied on by every apt block downstream: in this file, in every
# feature pack, and in every environment-overlay fragment. Each of those mounts /var/cache/apt and
# /var/lib/apt/lists as BuildKit caches, so a re-run that misses the layer cache still does not re-download.
# That matters because an overlay is `FROM` this image: publishing a new sandbox image changes this image's
# digest, which invalidates EVERY overlay layer above it, so a sandbox re-installs its whole environment on
# every update. The layer miss is unavoidable (the parent chain really did change); paying for the bytes twice
# is not. _tools/checks/build-cache-mounts.mjs enforces the mounts, and enforcement is what makes removing
# docker-clean safe: Debian's drop-in deletes the archives after each install, which would empty the very cache
# mount it is meant to fill, but with it gone an UNMOUNTED apt block would commit its .debs into the image.
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
    && printf 'Binary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/99intentic-keep-downloads
# Core runtime, terminal, sync, search and native-build tools; heavy or privilege-coupled capabilities belong in packs/overlays.
# SSH is key-only; generate host keys on persistent /history at boot, never in the image. tmux keeps processes alive across web disconnects.
# Python venv/pip plus Debian PyYAML/Pillow avoid PEP 668 failures for common scripts; uncommon toolchains remain overlay additions.
# bubblewrap is core access control: without it fenced turns must refuse to run, regardless of optional desktop tooling.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates procps tmux zsh ncurses-term curl openssh-server openssh-client sshpass rsync iproute2 python3 python3-pip python3-venv python-is-python3 python3-yaml python3-pil make g++ bubblewrap
# Standalone binaries must support both sandbox architectures without newer system libraries.
ARG RIPGREP_VERSION=15.2.0
ARG JQ_VERSION=1.8.2
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target=x86_64-unknown-linux-musl; rg_sha=33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c; jq_sha=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f ;; \
      arm64) target=aarch64-unknown-linux-musl; rg_sha=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915; jq_sha=8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309 ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${target}.tar.gz" -o /tmp/ripgrep.tar.gz; \
    echo "$rg_sha  /tmp/ripgrep.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/ripgrep.tar.gz -C /tmp; \
    install -m 0755 "/tmp/ripgrep-${RIPGREP_VERSION}-${target}/rg" /usr/local/bin/rg; \
    rm -rf /tmp/ripgrep.tar.gz "/tmp/ripgrep-${RIPGREP_VERSION}-${target}"; \
    curl -fsSL "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-${arch}" -o /usr/local/bin/jq; \
    echo "$jq_sha  /usr/local/bin/jq" | sha256sum -c -; \
    chmod +x /usr/local/bin/jq; \
    rg --version; jq --version
# Docker Engine, Chromium, provider CLIs et al. are NOT here — each is a feature pack (packs/<name>.Dockerfile)
# spliced at the markers below for the profiles that bake it, or riding the environment overlay on demand.
# Every runner still mounts a named volume at /var/lib/docker (empty until the docker capability's privilege
# grant) so a later engine install finds images and dev-DB volumes surviving recreates — and layers land on a
# real filesystem (overlay2), not the container's own overlayfs.
# Repos the agent creates by hand default to main, matching gitInit's --initial-branch and Forgejo.
RUN git config --global init.defaultBranch main
# Auth POLICY is baked (it is a constant of the image); the host key — the sandbox's SSH identity — is not, so
# that a rebuild cannot change who the sandbox claims to be. docker-entrypoint.sh writes the matching HostKey
# drop-in at boot.
RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh \
    && printf '%s\n' 'PasswordAuthentication no' 'PermitRootLogin prohibit-password' 'PubkeyAuthentication yes' > /etc/ssh/sshd_config.d/intentic.conf
# Fetch OMZ/plugin archives to avoid Git auth prompts. HISTFILE uses := on /history; HIST_SAVE_BY_COPY breaks history symlinks.
# Keep zle_highlight's other defaults and bracketed paste when setting paste:none.
# Disable OMZ titles: tmux control mode exposes ESC-k payloads as visible xterm text.
# Register busy-dot hooks after OMZ; missing /run/intentic/shell must stay silent.
RUN mkdir -p /root/.oh-my-zsh /root/.oh-my-zsh/custom/plugins/zsh-autosuggestions \
    && curl -fsSL https://github.com/ohmyzsh/ohmyzsh/archive/refs/heads/master.tar.gz \
        | tar -xz -C /root/.oh-my-zsh --strip-components=1 \
    && curl -fsSL https://github.com/zsh-users/zsh-autosuggestions/archive/refs/heads/master.tar.gz \
        | tar -xz -C /root/.oh-my-zsh/custom/plugins/zsh-autosuggestions --strip-components=1 \
    && printf '%s\n' \
        'export ZSH="$HOME/.oh-my-zsh"' \
        'ZSH_THEME="bira"' \
        'ZSH_DISABLE_COMPFIX=true' \
        "zstyle ':omz:update' mode disabled" \
        'plugins=(git zsh-autosuggestions)' \
        "ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=245'" \
        "PROMPT_EOL_MARK=''" \
        'zle_highlight=(region:standout special:standout suffix:bold isearch:underline paste:none)' \
        'DISABLE_AUTO_TITLE=true' \
        ': ${HISTFILE:=${HISTORY_ROOT:-/history}/shell/zsh_history}' \
        'HISTSIZE=100000' \
        'SAVEHIST=100000' \
        'source $ZSH/oh-my-zsh.sh' \
        'autoload -Uz add-zsh-hook' \
        '_intentic_prompt_signal() { { : >| /run/intentic/shell/prompt; } 2>/dev/null }' \
        'add-zsh-hook preexec _intentic_prompt_signal' \
        'add-zsh-hook precmd _intentic_prompt_signal' \
        > /root/.zshrc
# tmux provides persistence; control-mode clients feed raw pane bytes to browser xterm, which owns rendering, input and clipboard handling.
# Keep detached sessions and match history-limit to shell history so reconnect can replay scrollback.
# Hooks log every pane through pane-log-clean with matching dimensions; logs/log-files.ts rearms them after daemon restarts.
# Sanitize session names before shell interpolation; include pane IDs to keep log filenames unique.
RUN printf '%s\n' \
        'set -g status off' \
        'set -g history-limit 100000' \
        'setw -g aggressive-resize on' \
        'set -g default-terminal "tmux-256color"' \
        'set -g default-shell /bin/bash' \
        'set -g default-command zsh' \
        'set -g destroy-unattached off' \
        "set-hook -g session-created 'pipe-pane -o \"mkdir -p /history/logs/terminals; exec pane-log-clean /history/logs/terminals/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}\"'" \
        "set-hook -g after-new-window 'pipe-pane -o \"mkdir -p /history/logs/terminals; exec pane-log-clean /history/logs/terminals/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}\"'" \
        "set-hook -g after-split-window 'pipe-pane -o \"mkdir -p /history/logs/terminals; exec pane-log-clean /history/logs/terminals/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}\"'" \
        > /root/.tmux.conf \
# A login shell starts from /etc/profile's PATH, which drops what the daemon put in front of an agent's: the heavy-queue
# shims, pnpm, cargo, the extensions' commands. Codex runs every command through `bash -lc`, so its turns met "pnpm:
# command not found" 67 times in the ten days to 2026-10-26 (and cargo, suites, intentic-docs), with a field note telling
# each agent to re-export PATH by hand. The daemon hands a vendor shell its full PATH as INTENTIC_LOGIN_PATH
# (src/agent/run/vendor-shell-env.ts), which /etc/profile leaves alone; this puts it back, or the image's own dirs.
    && printf '%s\n' \
        'if [ -n "${INTENTIC_LOGIN_PATH:-}" ]; then PATH="$INTENTIC_LOGIN_PATH"; else PATH="/opt/sandbox/heavy-shims:/usr/local/share/pnpm/bin:/usr/local/cargo/bin:$PATH"; fi' \
        'export PATH' \
        > /etc/profile.d/00-intentic-path.sh
# The daemon runs the app's `pnpm dev` (dev-server.ts) and turns run `pnpm install` in /work, so this stage
# needs its own pnpm — the build stage's does not carry over. Installed natively rather than through corepack,
# the same way and for the same reasons as _tools/ci-base/Dockerfile: pnpm 12 is a Rust binary that needs no
# Node, it honours the `packageManager` pin itself (`pmOnFail` defaults to `download`), and corepack's version
# directories brought a half-written-cache failure mode and an exec bit it stripped off its own bundled
# node-gyp. The node-gyp that the rebuild below and an agent's own native builds use is the pinned global one
# installed underneath this, never a bundled copy, so nothing here needs that repair.
# ponytail: bump together with package.json's packageManager field.
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PATH
RUN curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.16.1 SHELL=/bin/sh ENV=/tmp/pnpm-env.sh sh - \
    && rm -f /tmp/pnpm-env.sh \
    && pnpm --version
# bun on PATH. Every package's tests run on Bun (`suites` is `bun test`), every typecheck is `bun check`, and the
# release cross-compiles the machine agent with `bun build --compile`, so a sandbox without it could not check its
# own work: until this was baked, the intentic workspace carried it as an environment-overlay step of its own, and
# any other workspace had none. Scripts inside the monorepo still run the lockfile's `bun` (the root devDependency);
# this is the one an agent types, a user's Bun project runs, and a heavy-shim (`bun` is one) falls through to.
# Copied out of the official image, as _tools/ci-base does, rather than fetched from a release zip: the digest pins
# both architectures at once, upstream verified the zip's signature when it built that image, and its amd64 binary
# is the `x64-baseline` build, which runs on a CPU without AVX2 (a laptop's or an old server's) where the plain x64
# release dies with SIGILL. -slim is trixie, this image's own release, so the glibc it links against is here.
# The pin is one of _tools/scripts/tools/tool-pins.mjs's: the tool bump moves it with ci-base's, the platform api's
# and the catalog's, and the `tool-pins` check refuses a hand edit that moves only some of them.
COPY --from=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx && bun --version && bunx --version
# Pin node-gyp and bump it with the Node base so native builds use compatible headers.
# Every npm install mounts ~/.npm as a BuildKit cache: tarballs survive rebuilds without duplicating package bytes in image layers.
# Do not npm cache clean a mounted cache; it adds no image savings and discards the next build's downloads.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g node-gyp@13.0.2 && node-gyp --version
# The provider CLIs — `opencode` (Grok), `cli-proxy-api` (the subscription translator) and `codex` — are
# feature packs: connected-provider state decides whether each rides the overlay (agent/providers/provider-packs.ts),
# and the standard profile bakes them all.
# cloudflared, for one job that has nothing to do with how this sandbox is reached: `intentic deploy apply`
# shells out to `cloudflared access tcp` to reach a self-host's SSH through the USER'S own Cloudflare tunnel
# (via:"cloudflared" hosts). It used to share this spot with a `zrok2` binary that WAS the reachability
# fabric; that fabric is the platform's own edge now, which the daemon dials over an outbound WebSocket with
# no binary to install (sandbox-contract/ingress-contract.ts). Placed HERE, before the tree COPYs below, so
# the layer stays cache-stable across source changes.
ARG CLOUDFLARED_VERSION=2026.10.4
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}" -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && /usr/local/bin/cloudflared --version
# Small generic CLIs agents and terminal users commonly reach for; keep heavy/task-specific tools and language toolchains in overlays.
# git-lfs needs install --system as well as the package, or clones silently leave pointer files. vim-tiny needs the familiar vim alias.
# Omit inert schedulers, absent man pages and interactive-only monitors; use existing automation and one-shot diagnostics.
# Keep this layer after pinned installs and before tree copies so additions and source changes do not invalidate expensive tool layers.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        lsof psmisc net-tools iputils-ping traceroute dnsutils netcat-openbsd socat strace \
        file tree unzip zip xz-utils zstd bzip2 sqlite3 patch bsdextrautils xxd libxml2-utils moreutils \
        less nano vim-tiny bc gettext-base uuid-runtime dos2unix wget git-lfs \
    && ln -s /usr/bin/vim.tiny /usr/local/bin/vim \
    && git lfs install --system
# yq on PATH — jq's counterpart for YAML, for editing a compose file, a CI pipeline or a k8s manifest from a
# shell pipeline instead of hand-patching it with sed. It was baked to cover the missing-PyYAML case too, and
# the transcripts say it did not: yq usage held at 0.6% of sessions across the bake while agents went on
# importing yaml. Hence PyYAML above — these two now serve different callers (shell vs Python), not one need
# with a preferred answer. Debian's own `yq` package is a DIFFERENT program (a Python wrapper around jq) whose
# write syntax is not the one every model has learned, so this is upstream's Go binary — pinned and
# version-checked like cloudflared, same rationale.
ARG YQ_VERSION=4.54.1
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${arch}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version
# gh, the GitHub CLI. Claude Code's own Bash guidance tells every turn to "use the gh CLI for GitHub operations", and
# agents here reached for it 149 times with nothing there (`gh run view --log-failed`, PRs, releases), which is the
# ordinary-CLI floor's admission test above. Upstream's release rather than Debian's `gh`: Debian stopped following
# it at 2.46.0 (March 2024, still the version in unstable), and gh is a client for an API that keeps moving under it.
# A static Go binary, sha256-checked per architecture like ripgrep and jq; the tool bumper
# (_tools/scripts/tools/bump-tools.mjs) moves the version and both checksums together.
ARG GH_VERSION=2.103.2
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gh_sha=62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8 ;; \
      arm64) gh_sha=4c3e99a50bd8b181a3fe9d69b25dd978bac768148d88f01507c6b4d1ef61a443 ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o /tmp/gh.tar.gz; \
    echo "$gh_sha  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
    gh --version
# ---- packs:pre-trees ---- (spliced by compose-image-dockerfile.mjs — pinned pack installs land here, ABOVE
# the tree COPYs, so a source change never evicts a pack download; the core profile carries none)

# The daemon's third-party node_modules, a layer apart from the rest of its tree (prepare-image-trees.sh moves them into
# this static layer root and fixes every timestamp). --link builds it apart from the layers under it, so it is the same
# bytes on every release whose lockfile moved none of them, and an update reuses it rather than downloading ~950 MiB of
# unchanged packages with each commit's daemon. Placed here, below the first per-commit layer (the CLI tree just after),
# because Docker's classic store re-downloads every layer above the first changed one whatever its digest. The tree
# COPY'd into /opt/sandbox below merges over it: the workspace's own packages, the .pnpm index and the daemon itself.
COPY --link --from=trees layers/sandbox-deps/ /
# Bake a ready-to-seed starter so first boot copies it into /work and starts the preview without paying an install delay.
# prepare-image-trees.sh builds starter/starter.Dockerfile through the same scaffolder as Add app, with runtime Node/pnpm paths.
# normalize-starter.mjs removes volatile install metadata so unchanged templates/lockfiles retain layer digests across releases.
COPY --link --from=trees layers/starter/ /
# The intentic CLI on PATH — the /intentic endpoint shells out to it for resolve/plan dry-runs, and
# connect.sh runs it via `--entrypoint intentic`. tsc emits cli.js without the exec bit, so chmod it:
# runc resolves the entrypoint with Go's exec.LookPath, which reports a non-executable PATH entry as
# "executable file not found in $PATH".
COPY --from=trees cli /opt/intentic-cli
RUN chmod +x /opt/intentic-cli/dist/cli.js \
    && ln -s /opt/intentic-cli/dist/cli.js /usr/local/bin/intentic
# The registry's metadata for the `pnpm` package, from the starter's build: pnpm resolves the starter's pinned pnpm
# through it before running the copy the starter layer above carries, so without it a seeded starter's first `pnpm`
# needs the network. Here among the per-commit layers, since it changes whenever pnpm publishes (starter.Dockerfile).
COPY --link --from=trees layers/pnpm-metadata/ /
# `tsx` as a shim over node's own type stripping. Agents reach for tsx to run a one-off .ts script because that
# is what the ecosystem taught them, and a project that lists it in devDependencies resolves its own — but a
# scratch script outside any package hit `tsx: not found` and the agent went looking for workarounds. Node 24
# executes TypeScript directly, so the shim is the whole implementation. NOT tsgo: that is a compiler (a tsc
# replacement) and cannot run a file. A project-local tsx still wins — node_modules/.bin precedes /usr/local/bin.
RUN printf '%s\n' '#!/bin/sh' 'exec node "$@"' > /usr/local/bin/tsx \
    && chmod +x /usr/local/bin/tsx
# The embedding model behind `iq ask` is the `semantic` feature pack (fetched into /opt/iq-models, where
# IQ_MODEL_DIR below points); absent — the core profile — iq degrades to lexical, never fetches at runtime.
# The iq Claude Code plugin (skill + SessionStart nudge) — the single source that teaches every agent to prefer
# iq over grep/find/Glob. Baked here and always loaded via IQ_PLUGIN_DIR (agent.routes.ts prepends it to the SDK
# `plugins` option), so iq is the default in the sandbox exactly as external users get it from the marketplace.
# Copied from the build context (the npm package ships only dist/ — the plugin lives beside it in the source tree).
COPY _search/iq/plugin /opt/iq-plugin
# The webq Claude Code plugin (skill only) — teaches every agent when to reach for webq over WebFetch. Always
# loaded via WEBQ_PLUGIN_DIR (turn-plan.ts), ungated: unlike iq there is no default-tool to displace and no
# experiment to run, the CLI is simply on PATH and the skill says when it helps.
COPY _sandbox/webq/plugin /opt/webq-plugin
# Claude Code's managed settings, which load whatever a turn's settingSources say, and the policy mod they run first
# (_sandbox/sandbox/claude-policy/plugins/intentic-guard). Without it a mod someone installs (Claude Code 2.1.287+)
# can answer or overturn the daemon's tool-call guards, which are SDK callbacks; with these settings present Claude
# Code also seats its own guard, sec-default, which keeps such mods off the system prompt. Claude Code counts a mod as
# the organization's only when its marketplace is a directory listing it by relative path, hence the /opt copy.
COPY _sandbox/sandbox/claude-policy /opt/intentic-claude-policy
COPY _sandbox/sandbox/claude-policy/managed-settings.json /etc/claude-code/managed-settings.json
# The sandbox daemon.
COPY --from=trees sandbox /opt/sandbox
# netd the entrypoint execs: every port, the ingress tunnel, and the daemon's supervision (_sandbox/netd). Built
# on this image's Debian release by build-netd.sh, so it links against the glibc this layer carries.
COPY --from=trees netd /opt/sandbox/netd
# Expose daemon dependencies through symlinks in one RUN to avoid duplicate trees and layers; Node resolves imports from realpaths.
# chmod also checks that every CLI shipped. lsp starts a fresh compiler per request; OCR needs the privacy pack's models or exits 2.
# fileq supplies Git textconv and rg document search; daemon diff routes use --no-textconv and render derived sides separately.
# memory-room shares the daemon's admission formula and fails open when the daemon or CLI is unavailable.
RUN chmod +x /opt/sandbox/node_modules/@intentic/lsp/dist/cli.js \
        /opt/sandbox/node_modules/@intentic/iq/dist/cli.js \
        /opt/sandbox/node_modules/@intentic/webq/dist/cli.js \
        /opt/sandbox/node_modules/@intentic/fileq/dist/cli.js \
        /opt/sandbox/node_modules/@intentic/fileq/bin/fileq-rg-pre \
        /opt/sandbox/node_modules/@intentic/ocr/dist/cli.js \
        /opt/sandbox/node_modules/@intentic/constants/src/memory-room.mjs \
        /opt/sandbox/dist/logs/pane-log-clean.js \
    && ln -s /opt/sandbox/node_modules/@intentic/lsp/dist/cli.js /usr/local/bin/lsp \
    && ln -s /opt/sandbox/node_modules/@intentic/iq/dist/cli.js /usr/local/bin/iq \
    && ln -s /opt/sandbox/node_modules/@intentic/webq/dist/cli.js /usr/local/bin/webq \
    && ln -s /opt/sandbox/node_modules/@intentic/fileq/dist/cli.js /usr/local/bin/fileq \
    && ln -s /opt/sandbox/node_modules/@intentic/fileq/bin/fileq-rg-pre /usr/local/bin/fileq-rg-pre \
    && ln -s /opt/sandbox/node_modules/@intentic/ocr/dist/cli.js /usr/local/bin/ocr \
    && ln -s /opt/sandbox/node_modules/@intentic/constants/src/memory-room.mjs /usr/local/bin/memory-room \
    && ln -s /opt/sandbox/dist/logs/pane-log-clean.js /usr/local/bin/pane-log-clean \
    && fileq git-attributes > /etc/gitattributes \
    && git config --global core.attributesFile /etc/gitattributes \
    && git config --global diff.fileq.textconv 'fileq read --plain' \
    && mkdir -p /etc/fileq \
    && fileq ripgrep-config --pre /usr/local/bin/fileq-rg-pre > /etc/fileq/ripgreprc
# Codex lives only in its pinned pack; prepare-image-trees.sh prunes the duplicate daemon-tree binary.
# Copy first-party manifests/data into every image; installedExtensions() discovers them through SANDBOX_EXTENSIONS_DIR.
# Gateway/CLI runtime trees belong to the messaging pack. Keep their manifests here so core images explicitly report absent runtimes.
# Missing manifest copies silently remove capability cards; do not copy partial runtimes that hide the missing pack.
COPY _extensions/connectors /opt/extensions/connectors
COPY _extensions/social /opt/extensions/social
COPY _extensions/devices /opt/extensions/devices
COPY _extensions/browsers /opt/extensions/browsers
COPY _extensions/phones /opt/extensions/phones
COPY _extensions/acp-agents /opt/extensions/acp-agents
COPY _extensions/pi-agent /opt/extensions/pi-agent
COPY _extensions/discord/intentic-extension.json /opt/extensions/discord/
COPY _extensions/imap/intentic-extension.json /opt/extensions/imap/
COPY _extensions/slack/intentic-extension.json /opt/extensions/slack/
COPY _extensions/telegram/intentic-extension.json /opt/extensions/telegram/
COPY _extensions/whatsapp/intentic-extension.json /opt/extensions/whatsapp/
COPY _extensions/google-workspace/intentic-extension.json /opt/extensions/google-workspace/
COPY _extensions/microsoft-365/intentic-extension.json /opt/extensions/microsoft-365/
COPY _extensions/prawo/intentic-extension.json /opt/extensions/prawo/
# The web-builtin UI extensions bake their MANIFEST ONLY — their code is compiled into the web bundle
# (extension-host/builtins.ts), so there is nothing daemon-side to ship. The manifest is what makes them exist
# for the daemon: `GET /extensions` then enumerates EVERY first-party extension through one enumerator (a count
# is not written here — it was hand-maintained, and was already wrong by one before anyone noticed; the list in
# extensions.routes.integration.test.ts is what actually holds the invariant),
# so the Extensions tab is a complete list with a working on/off switch instead of a view of one load path.
# The pairing is checked both ways — a manifest here with no compiled-in module shows as "missing" in the tab
# (image and web bundle built from different commits), and a module with no manifest shows as "unlisted".
#
# Only the INCLUDED set is here: the work loop, the windows onto engines the daemon runs regardless, and the
# data packs above. acceptance, documentation, maintenance, knowledge, deployments, issues and workflows are first-party
# too, but a sandbox is itself without them, so they are listed in the registry and installed from Extensions →
# Browse (each is its own repository, intentic/extension-<name>); nothing of theirs is baked.
COPY _extensions/activity/intentic-extension.json /opt/extensions/activity/
COPY _extensions/approvals/intentic-extension.json /opt/extensions/approvals/
COPY _extensions/automations/intentic-extension.json /opt/extensions/automations/
COPY _extensions/passwords/intentic-extension.json /opt/extensions/passwords/
COPY _extensions/git-history/intentic-extension.json /opt/extensions/git-history/
COPY _extensions/pipelines/intentic-extension.json /opt/extensions/pipelines/
COPY _extensions/preview/intentic-extension.json /opt/extensions/preview/
COPY _extensions/repo-apps/intentic-extension.json /opt/extensions/repo-apps/
COPY _extensions/viewers/intentic-extension.json /opt/extensions/viewers/
# onlyoffice is both: its viewer is compiled into the web bundle like the rows above, and its dist is what the daemon's
# extension host runs and serves: the backend (`server.js`: the browser engine's bundle download, the document server's
# lifecycle, the editor pages, the saves) and the browser engine's editor page (`editor/editor.js`). The dist rides the
# `trees` context (prepare-image-trees.sh BUNDLES) — a COPY from the repo tree would find nothing, .dockerignore
# excludes every dist. A manifest here without the dist shows as `absent` on the Extensions tab.
COPY _extensions/onlyoffice/intentic-extension.json /opt/extensions/onlyoffice/
COPY --from=trees extensions/onlyoffice/dist /opt/extensions/onlyoffice/dist
# e-urzad (EZD RP and e-Doręczenia for Polish public offices, and signature checks) is both as well: its rail view is
# compiled into the web bundle, and the daemon runs its backend (dist/server.js: the EZD RP card's agent tools and the
# view's routes) while the agent runs its CLI (contributes.bin: bin/e-urzad over dist/cli.js). Both are self-contained
# bundles from the `trees` context; the manifest, the cards' skill and the launcher come from the repository. Inert
# until an office connects one of its cards.
COPY _extensions/e-urzad/intentic-extension.json /opt/extensions/e-urzad/
COPY _extensions/e-urzad/skills /opt/extensions/e-urzad/skills
COPY --chmod=755 _extensions/e-urzad/bin /opt/extensions/e-urzad/bin
COPY --from=trees extensions/e-urzad/dist /opt/extensions/e-urzad/dist
# ---- packs:post-trees ---- (spliced by compose-image-dockerfile.mjs — packs that read the daemon tree or
# COPY from the trees context land here, below every tree COPY they depend on)
# Image-baked agent skills (the daemon runs as root; the agent's settingSources loads /root/.claude). The
# environment skill teaches the agent to extend this very image via an approved overlay Dockerfile; the
# intentic skill is the product's own reference, what the agent reads before it answers for the product.
COPY _sandbox/sandbox/seed-skills /root/.claude/skills
# The tmux command runner — the agent's PreToolUse hook (src/agent/tools/agent-terminals.ts) wraps every Bash tool
# command through it, and the daemon's terminal runner (src/terminal/terminal-run.ts) executes user-triggered
# flows through it, so commands run live-visible in tmux sessions — and the agent's output filter, which
# strips noise from what the model sees.
# The heavy-command queue a heavy program becomes as it starts (heavy-turn.cjs in @intentic/constants, matched by the
# program that really runs against the shared table plus .intentic/config/heavy-commands.json), so several sessions'
# test/typecheck fan-outs take turns instead of pinning the cgroup together. It holds an flock, so `flock`
# (util-linux) and, for the ceiling that takes a slot back from a command that hangs, `timeout` (coreutils) are its
# dependencies; both are already in the base, and a missing one degrades to running the command plainly — unqueued,
# or unbounded. Not on PATH ⇒ nothing queues, and heavy programs are still ranked (terminal-run.ts queueRunEnabled).
# Both runners above in one COPY: each instruction is a layer, and Docker refuses an image deeper than 125 (see the
# command block below).
COPY --chmod=755 _sandbox/sandbox/bin/tmux-run _sandbox/sandbox/bin/queue-run /usr/local/bin/
# The thin wrappers for heavy programs that are not node scripts (pnpm's own binary, bun, cargo), first on an agent
# command's PATH (src/workload/heavy-commands.ts heavyEnvPrefix); node programs are judged by the hook
# node loads for them instead. Each name is a link to the one wrapper.
COPY --chmod=755 _sandbox/sandbox/bin/heavy-shims /opt/sandbox/heavy-shims
# The output filter and its cleaner registry come from @intentic/output-cleaners, the same files the Claude Code plugin
# bundles; plain node-builtin .mjs, so they are copied as written rather than built.
COPY --chmod=755 _sandbox/output-cleaners/src/agent-output-filter.mjs /usr/local/bin/agent-output-filter
# The cleaner registry the filter imports (./cleaners.mjs resolves next to the renamed binary at /usr/local/bin), and
# the modules it imports in turn: one layer, since they share a mode and a directory.
COPY --chmod=755 _sandbox/output-cleaners/src/cleaners.mjs _sandbox/output-cleaners/src/cleaner-shapes.mjs _sandbox/output-cleaners/src/log-templates.mjs _sandbox/output-cleaners/src/json-arrays.mjs _sandbox/output-cleaners/src/search-fairness.mjs _sandbox/output-cleaners/src/output-cap.mjs _sandbox/output-cleaners/src/repeated-output.mjs _sandbox/output-cleaners/src/text-shaping.mjs /usr/local/bin/
# retrieve-output on PATH — the reversible half of the filter (fetch back elided output; the footer names it).
COPY --chmod=755 _sandbox/output-cleaners/src/retrieve-output.mjs /usr/local/bin/retrieve-output
# These CLIs relay through daemon routes so shell and UI actions share policy; optional clients such as VPN, netdisk and rtk live in overlays.
# Name the geo command separately from the shell's exit builtin. OTP returns short-lived codes without exposing stored seeds.
# capability-ask requests the owner's consent; it connects nothing and reads no credentials.
# Keep bin/needs-cli.mjs beside its callers: it shares the needs protocol and exit codes by relative import.
COPY --chmod=644 _sandbox/sandbox/bin/needs-cli.mjs /usr/local/bin/needs-cli.mjs
# Shell commands relay to the daemon, which owns consent, policy, budgets and credentials; no CLI may bypass those gates.
# Privacy values go to the daemon without printing; wallet keys stay on the platform and fleet creation requires approval.
# Offloaded commands snapshot/return changes and fall back locally when the selected runner cannot accept the work.
# Add commands to this single COPY: separate layers exhausted Docker's 125-depth limit and leave no room for environment overlays.
COPY --chmod=755 \
    _sandbox/sandbox/bin/vpn \
    _sandbox/sandbox/bin/geo \
    _sandbox/sandbox/bin/netdisk \
    _sandbox/sandbox/bin/extension \
    _sandbox/sandbox/bin/otp \
    _sandbox/sandbox/bin/capabilities \
    _sandbox/sandbox/bin/grants \
    _sandbox/sandbox/bin/environment \
    _sandbox/sandbox/bin/needs \
    _sandbox/sandbox/bin/automations \
    _sandbox/sandbox/bin/wallet \
    _sandbox/sandbox/bin/secrets \
    _sandbox/sandbox/bin/privacy \
    _sandbox/sandbox/bin/agents \
    _sandbox/sandbox/bin/devices \
    _sandbox/sandbox/bin/offload-run \
    _sandbox/sandbox/bin/on-screen \
    _sandbox/sandbox/bin/sandboxes \
    _sandbox/sandbox/bin/preview \
    /usr/local/bin/
# Entrypoint starts sshd (for Mutagen sync) then execs the daemon as PID 1.
COPY --chmod=755 _sandbox/sandbox/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
WORKDIR /work
# LANG: without a UTF-8 locale zsh's line editor counts BYTES as columns, so bira's multibyte prompt glyphs
# (╰─, ↵) desync the cursor and corrupt the prompt after any non-zero exit status. C.utf8 is glibc-built-in.
ENV WORKSPACE_ROOT=/work SANDBOX_PORT=8787 LANG=C.utf8 IQ_MODEL_DIR=/opt/iq-models IQ_PLUGIN_DIR=/opt/iq-plugin WEBQ_PLUGIN_DIR=/opt/webq-plugin EXTENSIONS_DIR=/opt/extensions
# Agent CLIs choose their command interpreter from SHELL; Claude Code also has its own override. Their generated
# commands use Bash semantics (field splitting, unmatched globs, arrays). Keep those semantics explicit, including
# nested `$SHELL -c` calls. The terminal remains interactive zsh through tmux's default-command above; changing a few
# noninteractive zsh options would still leave the two languages different.
ENV SHELL=/bin/bash CLAUDE_CODE_SHELL=/bin/bash
# The translator's fixed localhost endpoint + a loopback-only bearer (the token is just what Claude Code must
# send as ANTHROPIC_AUTH_TOKEN to a same-host proxy). The ENV is a pointer, not the binary — cli-proxy-api
# itself is the `translator` pack, and main.ts only spawns it when it is present and a connected provider
# routes through it. Baked in every profile so config.translator.url is set wherever the pack lands; a bare
# `tsx watch` dev run leaves both empty ⇒ no translator, and routed (codex/grok-under-Claude-Code) turns
# surface streamAgent's clean "no translator" error. The port is TRANSLATOR_PORT (@intentic/constants) — every
# fixed bind in this container is declared there and asserted distinct, because this line once read 8788 and
# silently fought the loopback listener for it. container-ports.test.ts holds the two in step.
ENV TRANSLATOR_URL=http://127.0.0.1:8789 TRANSLATOR_TOKEN=intentic-translator-local
# Privacy hardening for every agent CLI the daemon spawns (they all inherit process.env): telemetry, error
# reporting, feedback uploads, and update checks off — the CLIs are version-pinned in this image, so an update
# probe is pure phone-home. DO_NOT_TRACK covers Claude Code and anything else honoring the convention; Codex
# reads no env switches at all (its equivalents live in CODEX_HOME/config.toml — codex/codex-config.ts).
# OPENCODE_DISABLE_SHARE was OpenCode 1's one share switch a repo could not undo. OpenCode 2 has no sharing and no
# longer reads it; it stays for a 1.x `opencode` a person installs by hand, and costs nothing otherwise.
ENV DO_NOT_TRACK=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_FEEDBACK_COMMAND=1 \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_SHARE=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    GH_NO_EXTENSION_UPDATE_NOTIFIER=1
# Toolchain-wide telemetry opt-outs for everything that runs in the sandbox — the agent's Bash tool, the web
# terminals' zsh, and any install/build/dev command in /work inherit this env. Tools not baked into the image
# are covered on purpose: the agent installs toolchains at will, and an unused var is inert. Each name is the
# tool's own documented switch; folk-list vars that don't exist (VITE_/PODMAN_/DOCKER_CLI_ telemetry opt-outs,
# CRATES_EDITION_METRICS) are omitted, as is ANSIBLE_GATHERING=explicit — that changes playbook semantics, not
# privacy. npm audit/fund are off because install-time audit posts the dependency graph to the registry.
#
# INHERITANCE IS NOT UNIVERSAL, and a var set here is worth nothing where it does not reach. Two known holes:
#   - Containers under the sandbox's inner dockerd get none of this — only processes in the sandbox itself do.
#   - A TASK RUNNER may rebuild the environment rather than pass it down. Turborepo 2 defaults to envMode
#     `strict` and hands each task a reconstructed env, so `pnpm dev` in /work/intentic silently dropped 30 of
#     the 32 names below until turbo.json's `globalPassThroughEnv` re-declared them — `astro dev` ran with
#     telemetry ON for as long as that hole was open. A name ADDED here must be added there too.
# Anything else that spawns build/dev commands through a filtering layer needs the same treatment.
ENV DISABLE_OPENCOLLECTIVE=1 \
    ADBLOCK=true \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    YARN_ENABLE_TELEMETRY=0 \
    SCARF_ANALYTICS=false \
    NEXT_TELEMETRY_DISABLED=1 \
    NUXT_TELEMETRY_DISABLED=1 \
    GATSBY_TELEMETRY_DISABLED=1 \
    ASTRO_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    EXPO_NO_TELEMETRY=1 \
    STORYBOOK_DISABLE_TELEMETRY=1 \
    NG_CLI_ANALYTICS=false \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    SAM_CLI_TELEMETRY=0 \
    CHECKPOINT_DISABLE=1 \
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true \
    AZURE_CORE_COLLECT_TELEMETRY=0 \
    WRANGLER_SEND_METRICS=false \
    STRIPE_CLI_TELEMETRY_OPTOUT=1 \
    HASURA_GRAPHQL_ENABLE_TELEMETRY=false \
    HF_HUB_DISABLE_TELEMETRY=1 \
    CONDA_ANACONDA_ANON_USAGE=false
EXPOSE 8787 22
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
