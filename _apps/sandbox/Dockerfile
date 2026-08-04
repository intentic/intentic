# The per-project AI-agent sandbox image (published as registry.gitlab.com/radarsu/intentic/sandbox). The
# monorepo is compiled OUTSIDE Docker: _tools/scripts/prepare-image-trees.sh builds the six baked packages
# (turbo, warm cache) and prunes their production trees + the iq models into .image-out/, which enters this
# build as the named context `trees`. Every layer here is a pinned tool install (registry-cache-stable) or a
# cheap tree COPY, so a source change rebuilds in seconds — no pnpm install / turbo run inside a cacheless
# container. Build from the REPO ROOT (the main context still carries the source-copied bits — iq plugin,
# skills, bin scripts, entrypoint, connectors):
#   bash _tools/scripts/prepare-image-trees.sh
#   docker build --build-context trees=.image-out -f _apps/sandbox/Dockerfile -t registry.gitlab.com/radarsu/intentic/sandbox .
# At run time connect.sh / the workspace provider inject agent credentials (ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN) and mount the workspace volume at /work — neither is baked into the image.

FROM node:24.18.0-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS runtime
# Links the GitLab Container Registry package to the repo (inherits its visibility/permissions, shows under its Packages).
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
# procps gives the interactive terminal (system/terminal.ts) real process tools — `ps`, `top`, `kill` — so the
# owner can see what's running in the sandbox and reap a stuck dev command. zsh is the terminal's shell (below).
# tmux backs the terminal's sessions: each web tab attaches a tmux session, and the tmux server outlives the
# WebSocket, so a page reload / drop detaches (session + its running processes survive) instead of killing them.
# curl + jq back the CLI-tool integrations (e.g. the Discord `cli` capability's skill has the agent call
# Discord's REST API with `curl … | jq`); neither is in the slim base and the build stage's curl doesn't carry over.
# openssh-server is the transport for the local-sync feature: Mutagen on the laptop connects over SSH (through the
# sandbox's Cloudflare tunnel) to block-delta sync /work. Key-only (config drop-in below); the host key is NOT
# baked — docker-entrypoint.sh generates it onto the /history volume at boot (see there for why).
# openssh-client + sshpass + rsync back the `ssh` capability: the agent runs `ssh <alias>` / `rsync` against
# connected machines, with sshpass -f for the password-auth ones. iproute2 gives `ip`/`ss` diagnostics.
# Heavy or privilege-coupled capability tools (WireGuard, whisper.cpp) are NOT baked here — each capability
# carries a Dockerfile fragment the daemon composes into the sandbox's environment overlay on enable
# (see capabilities/capability.ts `fragment`), applied by an owner-run rebuild.
# python3 + make + g++ are the node-gyp toolchain: runtime `pnpm install` (ensure-intent.ts, scaffold
# inject-template.ts, or a dev in /work) compiles native deps from source — node-pty ships no linux
# prebuild, so it ALWAYS builds here. Uncommon toolchains (cmake, -dev headers) stay an overlay concern.
# ripgrep backs the iq search CLI's lexical engine (iq-engine shells into `rg --json`).
# python3-pip + python3-venv: python3 was already here for node-gyp, but with no way to INSTALL anything an
# agent reaching for ordinary Python tooling (Pillow to inspect a screenshot, a one-off script's dependency)
# hit `pip: command not found` and improvised. Debian marks the system interpreter externally-managed, so
# `pip install` outside a venv refuses by design — venv is what makes pip usable rather than merely present.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates procps tmux zsh ncurses-term curl jq openssh-server openssh-client sshpass rsync iproute2 python3 python3-pip python3-venv make g++ ripgrep \
    && rm -rf /var/lib/apt/lists/*
# Docker Engine + Compose + buildx are baked into the base sandbox but stay DORMANT: every runner
# (connect.sh/.ps1, dev-sandbox.sh, rebuild.sh, update.sh, the workspace provider) starts this container
# unprivileged, and dockerd (which needs --privileged) only runs once the docker CAPABILITY is added — its
# fragment's "# intentic:runtime --privileged" directive rides the owner-approved overlay into an allowlisted
# rebuild, after which the daemon runs dockerd as the visible panel-docker tmux session. Baking the engine
# anyway keeps that grant a near-instant rebuild (a cache-hit FROM + directive overlay), not an engine install.
# Every runner mounts a named volume at /var/lib/docker (empty until the grant) so images and dev-DB volumes
# survive recreates — and layers land on a real filesystem (overlay2), not the container's own overlayfs.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*
# Repos the agent creates by hand default to main, matching gitInit's --initial-branch and Forgejo.
RUN git config --global init.defaultBranch main
# Auth POLICY is baked (it is a constant of the image); the host key — the sandbox's SSH identity — is not, so
# that a rebuild cannot change who the sandbox claims to be. docker-entrypoint.sh writes the matching HostKey
# drop-in at boot.
RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh \
    && printf '%s\n' 'PasswordAuthentication no' 'PermitRootLogin prohibit-password' 'PubkeyAuthentication yes' > /etc/ssh/sshd_config.d/intentic.conf
# The terminal (system/terminal.ts) launches zsh with the oh-my-zsh "bira" theme + zsh-autosuggestions, so the
# owner gets a real prompt and history autocomplete. Installed into root's home (the daemon/terminal run as
# root); --depth=1 tracks the default branch (pin to a commit if reproducibility matters).
#
# THE HISTORY LIVES ON THE VOLUME, NOT IN THE CONTAINER. zsh-autosuggestions' default strategy is `history`: it
# can only ghost-suggest what is in $HISTFILE, and oh-my-zsh leaves that at ~/.zsh_history — inside /root, the
# container's own writable layer. Every rebuild (docker rm -f + docker run, same named volumes) therefore
# shipped the plugin back working and the file back empty, and the owner re-typed what they had already typed.
# /history is the daemon's volume, already home to the pane logs (/history/logs/terminals) that this is the
# typed half of, and outside the /work the agent writes and Mutagen syncs.
# `:=` rather than a plain assignment so a caller that already set HISTFILE keeps it: panel sessions do exactly
# that (processes/managed-processes.ts), which is what keeps a dev-server command the DAEMON typed out of the
# owner's suggestions.
# Symlinking ~/.zsh_history onto the volume — the trick that persists ~/.claude (sessions/session-store.ts) —
# does NOT work here and must not be reintroduced: HIST_SAVE_BY_COPY (on by default) rewrites the file by
# renaming a temp over it whenever history is trimmed to SAVEHIST, which replaces the symlink with an ordinary
# container-local file and silently ends the persistence a few dozen commands in.
# HISTSIZE/SAVEHIST are set because oh-my-zsh only ever RAISES them (to 50000/10000) — a ceiling sized for a
# file that died with the container. Matched to tmux's history-limit below, since both bound the same thing:
# how far back the owner can reach in a terminal.
RUN git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /root/.oh-my-zsh \
    && git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions /root/.oh-my-zsh/custom/plugins/zsh-autosuggestions \
    && printf '%s\n' \
        'export ZSH="$HOME/.oh-my-zsh"' \
        'ZSH_THEME="bira"' \
        'ZSH_DISABLE_COMPFIX=true' \
        "zstyle ':omz:update' mode disabled" \
        'plugins=(git zsh-autosuggestions)' \
        "ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=245'" \
        "PROMPT_EOL_MARK=''" \
        ': ${HISTFILE:=${HISTORY_ROOT:-/history}/shell/zsh_history}' \
        'HISTSIZE=100000' \
        'SAVEHIST=100000' \
        'source $ZSH/oh-my-zsh.sh' \
        > /root/.zshrc
# tmux backs each terminal tab (system/terminal.ts attaches one session per tab). The web UI draws the tab bar,
# so the tmux status bar is off; default-command launches the oh-my-zsh zsh above (not /bin/sh); destroy-unattached
# off keeps a session alive when its web client detaches on reload/drop — the whole point of tmux-backed persistence.
# Mouse is ON because a tmux CLIENT runs on the alternate screen (its first bytes to the pty are ?1049h), and
# the alternate screen has no scrollback — so with mouse off the wheel is not a scroll at all: xterm takes its
# no-scrollback branch and sends arrow keys to the pty instead, which at a post-run prompt walks zsh history and
# leaves a command the user never typed sitting on the prompt line. On, the wheel reaches tmux, which scrolls
# the history-limit above; tmux's default WheelUpPane is `copy-mode -e`, so scrolling back to the bottom leaves
# copy-mode on its own, and copy-mode's `y` lands in the browser clipboard through set-clipboard/OSC 52 below.
# The cost is that mouse reporting is now always on, so a plain drag would belong to the pane rather than the
# browser — the web client's own gate (terminalSession.ts) is written for exactly that mode and keeps a drag a
# native selection while letting a click through.
# The set-hook pipe-pane trio logs every pane (web tabs, panels, agent-run tmux, windows, splits) to
# /history/logs/terminals — the crashed-session post-mortem the /logs routes serve (logs/log-files.ts keeps
# the same hooks for re-arming a server that outlived a daemon restart). The stream is replayed through
# pane-log-clean (a headless VT emulator) which owns each file and rewrites the rendered screen, so the
# persisted log is what the terminal actually showed, not raw escape/redraw noise (the live pane still shows
# raw color via the xterm WebSocket, unaffected). Pane width/height are passed so wrapping/cursor math match.
# The session name is sanitized by the s||| format modifier because it lands in a shell command; the pane id
# keeps names unique.
RUN printf '%s\n' \
        'set -g status off' \
        'set -g history-limit 100000' \
        'set -g mouse on' \
        'setw -g aggressive-resize on' \
        'set -g default-terminal "tmux-256color"' \
        'set -g default-command zsh' \
        'set -g destroy-unattached off' \
        'set -g set-clipboard on' \
        "set -as terminal-overrides ',xterm-256color:Ms=\\E]52;%p1%s;%p2%s\\007'" \
        "set-hook -g session-created 'pipe-pane -o \"mkdir -p /history/logs/terminals; exec pane-log-clean /history/logs/terminals/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}\"'" \
        "set-hook -g after-new-window 'pipe-pane -o \"mkdir -p /history/logs/terminals; exec pane-log-clean /history/logs/terminals/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}\"'" \
        "set-hook -g after-split-window 'pipe-pane -o \"mkdir -p /history/logs/terminals; exec pane-log-clean /history/logs/terminals/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}\"'" \
        > /root/.tmux.conf
# The daemon runs the app's `pnpm dev` (dev-server.ts) — the build stage's corepack doesn't carry over, so
# enable it here too and bake in the repo's pinned pnpm so the sandbox needs no first-run download or prompt.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# chmod as in the build stage: in-sandbox `pnpm install` (dev in /work, scaffold inject) compiles node-pty
# from source, and corepack strips the exec bit off its bundled node-gyp gyp_main.py (else Error 126).
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate \
    && find "$HOME/.cache/node/corepack" -path '*node-gyp/gyp/gyp_main.py' -exec chmod +x {} +
# node-gyp on PATH, for the native rebuild that runs after the tree COPYs below (node-pty, @discordjs/opus) and
# for an agent compiling a native dep by hand. Installed HERE, above those COPYs, because it used to share the
# rebuild's RUN — where every source change re-downloaded it, unpinned, before any compiling started. Pinned
# like every other tool in this image so a bad upstream release fails a deliberate bump, not the next pipeline.
# ponytail: bump alongside the node base image — node-gyp tracks the headers it compiles against.
#
# EVERY `npm install` IN THIS FILE ENDS IN A CACHE CLEAN. npm keeps the downloaded tarball in ~/.npm/_cacache
# next to the package it unpacked, and cacache stores that tarball exactly as the registry served it — already
# gzipped — so an uncleaned layer pays for the same bytes twice in every pull, and the second copy barely
# compresses. Measured in the published image: 420 MiB of tarballs left behind by the global installs and another
# 45 MiB by the playwright layer, ~23% of a 2 GB pull, for a cache nothing reads (installs in /work are pnpm's,
# and its store lives on the volume).
RUN npm install -g node-gyp@13.0.1 && node-gyp --version && npm cache clean --force
# The `opencode` CLI on PATH — the Grok provider (grok/opencode.ts) spawns `opencode serve` via
# @opencode-ai/sdk's createOpencodeServer, which shells out to this binary. xAI OAuth tokens are persisted by
# OpenCode under XDG_DATA_HOME, which the service pins to the workspace's .intentic so they survive restarts.
# The agent's shell also drives it directly (`opencode run`) to delegate tasks to Grok (agent/delegation.ts).
# Pin the CLI in lockstep with the SDK version in _apps/sandbox/package.json so the client/server wire API matches.
# ponytail: bump this together with @opencode-ai/sdk; a version skew surfaces as server-start / event-shape errors.
RUN npm install -g opencode-ai@1.17.15 && opencode --version && npm cache clean --force
# OpenCode privacy defaults, in the GLOBAL config (the only level where autoupdate:false is honored): no
# auto-update (the CLI is version-pinned above) and no session sync to opncd.ai, even manual /share. The
# daemon's server-spawn config (grok/opencode.ts) merges over this file, so runtime overrides are unaffected.
RUN mkdir -p /root/.config/opencode \
    && printf '{ "autoupdate": false, "share": "disabled" }\n' > /root/.config/opencode/opencode.json
# The `cli-proxy-api` binary on PATH — CLIProxyAPI, the translator that lets the Claude Code harness drive
# Codex/Grok/Kimi/Google models on the user's SUBSCRIPTION OAuth: agent/translator.ts spawns it as the server (a
# routed turn's ANTHROPIC_BASE_URL points at it), and its Management/device flows connect the subscriptions. A
# prebuilt Go release, pinned like the npm CLIs above.
# ponytail: bump the pin deliberately; a wire-API or Management-endpoint change surfaces as a translator-only
# failure (native-harness turns never touch it).
ARG CLIPROXY_VERSION=7.2.110
RUN arch="$(dpkg --print-architecture)" \
    && mkdir -p /tmp/cliproxy \
    && curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY_VERSION}/CLIProxyAPI_${CLIPROXY_VERSION}_linux_${arch}.tar.gz" | tar -xz -C /tmp/cliproxy \
    && install -m 0755 "$(find /tmp/cliproxy -type f -name cli-proxy-api | head -n1)" /usr/local/bin/cli-proxy-api \
    && test -x /usr/local/bin/cli-proxy-api \
    && rm -rf /tmp/cliproxy
# cloudflared on PATH — `intentic deploy apply` shells out to `cloudflared access tcp` to reach a self-host's SSH
# through its Cloudflare tunnel when the host is registered with via:"cloudflared" (a NAT'd local machine).
# Pinned to the same version connect.sh runs as the tunnel sidecar. Placed HERE, before the tree COPYs below,
# so the layer stays cache-stable across source changes.
ARG CLOUDFLARED_VERSION=2026.7.3
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}" -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && /usr/local/bin/cloudflared --version
# The ordinary-CLI floor. Every install above is here because a FEATURE needs it; this layer is here because
# an AGENT reaches for it. Mining this workspace's session transcripts (both `command not found` and invoked
# binaries that resolve to nothing) shows a model does not adapt gracefully when a staple is missing — it
# improvises around it and the work gets worse: `file` was reached for in 8 sessions, `netstat` in 7, `tree`
# in 3, `lsof`/`fuser` in 3 more, and not once did the agent install any of them. That same mining is what put
# pip and the tsx shim in this image; below is the rest of the list, held to tools that are small, generic,
# and useful to the owner in a web terminal too.
#   diagnostics — lsof/fuser answer "what is holding this port or file", the question an agent asks every time
#     a dev server won't bind and the one `ss` only half answers; net-tools is muscle memory (netstat,
#     ifconfig) that no amount of iproute2 displaces; strace is the only way to see where something hangs;
#     psmisc also brings killall/pstree; ping/traceroute/dnsutils/netcat/socat are the reachability ladder.
#   files & data — file identifies a blob before the agent cats 2 MiB of binary into its own context; tree is
#     how a model asks for a directory's shape; unzip/zip/xz/zstd/bzip2 open what curl brings back; sqlite3
#     reads the .db a project keeps in-repo; patch applies a diff that isn't a git commit; bsdextrautils/xxd
#     (hexdump, column) read the bytes; libxml2-utils and moreutils cover the two idioms with no shell
#     equivalent — xmllint and `cmd file | sponge file`.
#   shell floor — less (git's pager; without it a terminal `git log` is an unpaged wall), nano + vim-tiny
#     (nano takes Debian's `editor` alternative, so an interactive `git commit` stops erroring out — the
#     tradeoff is that a no -m commit now waits on an editor instead of failing fast, which is why the agent
#     is told to always pass -m; vim-tiny registers `vi` but NOT `vim`, so the symlink below spares everyone
#     who types the name they actually know — it is the reduced build, which beats a missing one), bc,
#     envsubst, uuidgen, dos2unix, and wget — curl is baked, but half the install instructions on the
#     internet, and in the model's weights, say wget.
#   git-lfs is the one whose absence is SILENT: cloning an LFS repo without it yields pointer files that look
#     like content, so the agent reads 130-byte stubs and reports on them. `install --system` registers the
#     filters image-wide; the package alone does not.
# Deliberately NOT here: shellcheck (18 MiB for a linter agents don't run on themselves), cron/at (nothing
# runs a cron daemon — automations own scheduling, and an inert crontab that accepts jobs it will never fire
# is worse than no crontab), man-db (a slim base ships no man pages for it to read), htop/ncdu (interactive-
# only: an agent that starts one just waits out its timeout — `top` and `du` already answer the same question
# in one shot), ffmpeg/imagemagick/pandoc and the database clients (heavy and task-specific — capability or
# overlay), the language toolchains (overlay, as above), and fd (Debian installs it as `fdfind`, and a tool
# present under the wrong name costs more turns than an absent one). Placed after the pinned installs above
# so adding a staple here never re-runs the Docker/Chromium layers, and before the tree COPYs so it stays
# cache-stable across source changes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        lsof psmisc net-tools iputils-ping traceroute dnsutils netcat-openbsd socat strace \
        file tree unzip zip xz-utils zstd bzip2 sqlite3 patch bsdextrautils xxd libxml2-utils moreutils \
        less nano vim-tiny bc gettext-base uuid-runtime dos2unix wget git-lfs \
    && ln -s /usr/bin/vim.tiny /usr/local/bin/vim \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*
# yq on PATH — jq's counterpart for YAML, and until now there was NO way to read a YAML file programmatically
# here: python3 is baked for node-gyp, but Debian's interpreter ships no PyYAML, so an agent editing a compose
# file, a CI pipeline or a k8s manifest had to hand-patch it with sed. Debian's own `yq` package is a
# DIFFERENT program (a Python wrapper around jq) whose write syntax is not the one every model has learned, so
# this is upstream's Go binary — pinned and version-checked like cloudflared/rtk, same rationale.
ARG YQ_VERSION=4.53.3
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${arch}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version
# Chromium for the agent's browser tools, deliberately the LAST layer above the tree COPYs. The revision has to
# be the one the daemon's own playwright resolves — browser-tools.ts calls chromium.executablePath() on it and
# hands the result to @playwright/mcp as --executable-path — and a playwright version pins its chromium
# revision, so installing the version prepare-image-trees.sh deployed gives the same revision by construction.
# Passing that version through a few-byte file is the whole point: this layer's cache key moves only when
# playwright is upgraded. Driving the install from the tree instead (`cd /opt/sandbox && node
# node_modules/playwright/cli.js install`) reads the exact same module, but it has to sit BELOW
# `COPY --from=trees sandbox`, where every commit evicted it — 2m09s re-downloading ~180 MiB, in both the images
# and release jobs, every pipeline. `install-deps` pulls the shared libraries Chromium links against (fonts,
# nss, libdrm…), which a plain `install chromium` does not.
#
# Baked, not left to a rebuild: a browser is ordinary for coding work (open the docs, screenshot the dev server
# you just changed), and the alternative is what actually happened — an agent asked to look at a URL found no
# browser, ran `npx playwright install` mid-turn, and burned a quarter of its session pulling 114 MiB into a
# container layer that a recreate then threw away. ~180 MiB of image is the cheaper side of that trade. The
# download lands in /root/.cache/ms-playwright, which is exactly where executablePath() looks.
#
# THE HEADLESS SHELL IS DELETED AGAIN IMMEDIATELY. `install chromium` fetches two browsers — chromium (389 MiB
# on disk) and chromium-headless-shell (262 MiB) — and playwright only ever launches the shell for the
# `chromium-headless-shell` channel or its own default headless launch. Neither happens here: both MCP specs
# (browser-tools.ts browserServerSpec / isolatedBrowserSpec, headed and --headless) pass --executable-path from
# chromium.executablePath(), which is the full browser, and browser-login.ts launches headed. There is no flag
# to fetch one without the other, so it goes after the fact, in the same layer that downloaded it.
# If a future launch drops --executable-path or asks for the shell channel, this rm is what breaks it — restore
# the shell there rather than resolving a missing-browser error at runtime.
COPY --from=trees playwright-version /opt/playwright-version
RUN npx --yes playwright@"$(cat /opt/playwright-version)" install --with-deps chromium \
    && rm -rf /root/.cache/ms-playwright/chromium_headless_shell-* \
    && rm -rf /var/lib/apt/lists/* /root/.npm/_npx \
    && npm cache clean --force
# The intentic CLI on PATH — the /intentic endpoint shells out to it for resolve/plan dry-runs, and
# connect.sh runs it via `--entrypoint intentic`. tsc emits cli.js without the exec bit, so chmod it:
# runc resolves the entrypoint with Go's exec.LookPath, which reports a non-executable PATH entry as
# "executable file not found in $PATH".
COPY --from=trees cli /opt/intentic-cli
RUN chmod +x /opt/intentic-cli/dist/cli.js \
    && ln -s /opt/intentic-cli/dist/cli.js /usr/local/bin/intentic
# The iq search CLI on PATH — the agent's primary code-search tool (every backend's Bash tool inherits PATH)
# and the daemon's /workspace/search backend (execFile `iq --json`). Same chmod rationale as intentic above.
COPY --from=trees iq /opt/iq
RUN chmod +x /opt/iq/dist/cli.js \
    && ln -s /opt/iq/dist/cli.js /usr/local/bin/iq
# `tsx` as a shim over node's own type stripping. Agents reach for tsx to run a one-off .ts script because that
# is what the ecosystem taught them, and a project that lists it in devDependencies resolves its own — but a
# scratch script outside any package hit `tsx: not found` and the agent went looking for workarounds. Node 24
# executes TypeScript directly, so the shim is the whole implementation. NOT tsgo: that is a compiler (a tsc
# replacement) and cannot run a file. A project-local tsx still wins — node_modules/.bin precedes /usr/local/bin.
RUN printf '%s\n' '#!/bin/sh' 'exec node "$@"' > /usr/local/bin/tsx \
    && chmod +x /usr/local/bin/tsx
# The baked embedding model behind `iq ask` (IQ_MODEL_DIR below); absent → iq degrades to lexical, never fetches.
COPY --from=trees iq-models /opt/iq-models
# The iq Claude Code plugin (skill + SessionStart nudge) — the single source that teaches every agent to prefer
# iq over grep/find/Glob. Baked here and always loaded via IQ_PLUGIN_DIR (agent.routes.ts prepends it to the SDK
# `plugins` option), so iq is the default in the sandbox exactly as external users get it from the marketplace.
# Copied from the build context (not /out/iq — the npm package ships only dist/, the plugin lives beside it).
COPY _apps/iq/plugin /opt/iq-plugin
# The sandbox daemon.
COPY --from=trees sandbox /opt/sandbox
# Native modules without portable prebuilds (node-pty always; @discordjs/opus has none for this Node major)
# get source-compiled by whatever host ran pnpm deploy — linked against THAT host's glibc. Rebuild them against
# this image's glibc with the baked toolchain (python3/make/g++ above; the node image ships its own headers, so
# node-gyp compiles offline). Without this, a tree deployed on a newer-glibc dev box ships binaries this
# runtime can't load. Driven directly, not via `npm rebuild`: node-pty's npm install script wants tsc (its lib/
# is already compiled in the tarball — only the .node needs building), and opus's loader requires the exact
# glibc-tagged prebuild dir its node-pre-gyp install lays down after the stale tags are removed.
# The registry-prebuilt natives (sharp, ast-grep, onnxruntime, davey) are manylinux — safe as copied.
RUN cd /opt/sandbox/node_modules/.pnpm/node-pty@*/node_modules/node-pty \
    && node-gyp rebuild \
    && cd /opt/sandbox/node_modules/.pnpm/@discordjs+opus@*/node_modules/@discordjs/opus \
    && rm -rf prebuild build-tmp-napi-v3 \
    && npm run install \
    && npm cache clean --force
# The lsp CLI on PATH — the agent's TypeScript rename + diagnostics tool, gated by the lspTools setting (the
# daemon writes/removes its skill at /work/.claude/skills/lsp). It drives the TS language service (its own
# bundled typescript) over whatever tsconfig project the agent points it at in /work. `lsp diag` and the
# sandbox's post-edit hook both route through a resident `lsp daemon`, started on demand by whichever asks
# first and shared via one socket per repo — so no service runs for a workspace without TypeScript in it.
#
# Symlinked out of the DAEMON'S tree rather than deployed as a tree of its own: @intentic/lsp is a dependency of
# @intentic/sandbox, so /opt/sandbox already contains this exact package (and its bundled typescript) — a second
# `pnpm deploy` root shipped a 54 MiB duplicate of it, 14.6 MiB of the pull. Node resolves the CLI's imports from
# the target's realpath inside /opt/sandbox/node_modules, the pane-log-clean precedent below. The chmod is the
# iq/intentic rationale — and it doubles as this layer's existence check: a tree that stopped carrying the
# package fails the build here instead of leaving `lsp` off PATH.
RUN chmod +x /opt/sandbox/node_modules/@intentic/lsp/dist/cli.js \
    && ln -s /opt/sandbox/node_modules/@intentic/lsp/dist/cli.js /usr/local/bin/lsp
# The `codex` CLI on PATH — the agent's shell delegates tasks to the user's connected Codex account
# (`codex exec`, agent/delegation.ts), authenticated via the CODEX_HOME injected per turn.
#
# Also symlinked out of the daemon's tree, and here the duplicate was worse than wasted bytes: @openai/codex-sdk
# (the Codex primary adapter) depends on @openai/codex at an EXACT version, so the tree already carries the
# platform binary — 350 MiB of it — and the `npm install -g @openai/codex@…` this replaces added a second,
# separately-pinned 280 MiB copy, 220 MiB of the pull. The two pins were supposed to move together and had
# already drifted: the image shipped codex-cli 0.142.5 on PATH while the SDK drove 0.146.0. Resolving the
# wrapper out of the tree makes that skew unrepresentable, and deletes the pin nobody has to remember.
# The wrapper (not the vendored binary) is the symlink target: it is what picks the platform package, so this
# stays arch-agnostic. `codex --version` is the guard — a tree layout change fails the build, loudly.
RUN codex_bin="$(find /opt/sandbox/node_modules/.pnpm -maxdepth 6 -path '*@openai/codex/bin/codex.js' | head -n1)" \
    && ln -s "$codex_bin" /usr/local/bin/codex \
    && codex --version
# Image-baked first-party extensions — one manifest checkout per subdir, enumerated by installedExtensions()
# via SANDBOX_EXTENSIONS_DIR (the iq-plugin precedent): present in every sandbox, not removable, no capability
# entry. connectors, social, computers and acp-agents are data-only (manifest + skill packs + client image
# fragments) so they copy straight from context; discord, imap and slack ship their deployed gateway trees from
# the trees context (node_modules included).
#
# The four data-only packs are what makes the /capabilities grid: every card that is a ROW over a generic core
# handler (a cli connector, a social platform, an OS pack, an ACP preset) is one of these manifest entries, so
# switching a pack off removes exactly its cards. Miss a COPY and those cards silently vanish from the grid.
COPY _extensions/connectors /opt/extensions/connectors
COPY _extensions/social /opt/extensions/social
COPY _extensions/computers /opt/extensions/computers
COPY _extensions/acp-agents /opt/extensions/acp-agents
COPY --from=trees extensions/discord /opt/extensions/discord
# Same glibc rationale as the sandbox rebuild above — the discord gateway's voice stack compiles opus from source.
RUN cd /opt/extensions/discord/node_modules/.pnpm/@discordjs+opus@*/node_modules/@discordjs/opus \
    && rm -rf prebuild build-tmp-napi-v3 \
    && npm run install
COPY --from=trees extensions/imap /opt/extensions/imap
# The slack gateway is pure JS (Socket Mode over undici) — no native build step to redo after the COPY.
COPY --from=trees extensions/slack /opt/extensions/slack
# documentation is a UI extension with daemon-side contributions, so it sits between the two groups: its views are
# compiled into the web bundle like the manifest-only ones below, but `contributes.bin` (the intentic-docs CLI the
# agent runs) and `contributes.agent` (the documenting skill) are read from the image, so those two directories have
# to be here or the CLI never reaches the agent's PATH and the skill never loads. Straight from context rather than
# the trees stage: both are dependency-free — plain ESM and markdown — so there is no node_modules to deploy. `src/`
# is deliberately not copied; that is the web bundle's half.
COPY _extensions/documentation/intentic-extension.json /opt/extensions/documentation/
COPY _extensions/documentation/bin /opt/extensions/documentation/bin
COPY _extensions/documentation/plugin /opt/extensions/documentation/plugin
# The web-builtin UI extensions bake their MANIFEST ONLY — their code is compiled into the web bundle
# (extension-host/builtins.ts), so there is nothing daemon-side to ship. The manifest is what makes them exist
# for the daemon: `GET /extensions` then enumerates all sixteen first-party extensions through one enumerator,
# so the Extensions tab is a complete list with a working on/off switch instead of a view of one load path.
# The pairing is checked both ways — a manifest here with no compiled-in module shows as "missing" in the tab
# (image and web bundle built from different commits), and a module with no manifest shows as "unlisted".
COPY _extensions/acceptance/intentic-extension.json /opt/extensions/acceptance/
COPY _extensions/activity/intentic-extension.json /opt/extensions/activity/
COPY _extensions/automations/intentic-extension.json /opt/extensions/automations/
COPY _extensions/deployments/intentic-extension.json /opt/extensions/deployments/
COPY _extensions/git-history/intentic-extension.json /opt/extensions/git-history/
COPY _extensions/logs/intentic-extension.json /opt/extensions/logs/
COPY _extensions/maintenance/intentic-extension.json /opt/extensions/maintenance/
COPY _extensions/memory/intentic-extension.json /opt/extensions/memory/
COPY _extensions/pipelines/intentic-extension.json /opt/extensions/pipelines/
COPY _extensions/preview/intentic-extension.json /opt/extensions/preview/
COPY _extensions/repo-apps/intentic-extension.json /opt/extensions/repo-apps/
COPY _extensions/viewers/intentic-extension.json /opt/extensions/viewers/
COPY _extensions/workflows/intentic-extension.json /opt/extensions/workflows/
# pane-log-clean on PATH — the tmux pipe-pane hooks (above / logs/log-files.ts) replay each pane's byte
# stream through it (a headless VT emulator using @xterm/headless from the daemon's node_modules) to keep
# the terminal logs readable. Symlinked like intentic/iq: node resolves @xterm/headless from the target's
# realpath (/opt/sandbox/node_modules); tsc keeps the file's shebang, so chmod +x makes it directly runnable.
RUN chmod +x /opt/sandbox/dist/logs/pane-log-clean.js \
    && ln -s /opt/sandbox/dist/logs/pane-log-clean.js /usr/local/bin/pane-log-clean
# Image-baked agent skills (the daemon runs as root; the agent's settingSources loads /root/.claude). The
# environment skill teaches the agent to extend this very image via an approved overlay Dockerfile.
COPY _apps/sandbox/skills /root/.claude/skills
# The tmux command runner — the agent's PreToolUse hook (src/agent/agent-terminals.ts) wraps every Bash tool
# command through it, and the daemon's terminal runner (src/terminal/terminal-run.ts) executes user-triggered
# flows through it, so commands run live-visible in tmux sessions — and the agent's output filter, which
# strips noise from what the model sees.
COPY --chmod=755 _apps/sandbox/bin/tmux-run /usr/local/bin/tmux-run
COPY --chmod=755 _apps/sandbox/bin/agent-output-filter.mjs /usr/local/bin/agent-output-filter
# The cleaner registry the filter imports (./cleaners.mjs resolves next to the renamed binary at /usr/local/bin).
COPY --chmod=755 _apps/sandbox/bin/cleaners.mjs /usr/local/bin/cleaners.mjs
# retrieve-output on PATH — the reversible half of the filter (fetch back elided output; the footer names it).
COPY --chmod=755 _apps/sandbox/bin/retrieve-output.mjs /usr/local/bin/retrieve-output
# rtk (rtk-ai/rtk, Apache-2.0) — the alternate cleaner backend the `filterBackend` setting switches to (the
# PreToolUse hook rewrites each Bash command to `rtk <cmd>` and turns the native filter off). Baked, not shipped
# as an installable extension's fragment: the setting is a plain toggle with no capability behind it, so an
# extension-gated binary meant flipping it silently broke EVERY Bash command with `rtk: command not found`
# until the owner happened to install an extension and rebuild. A ~10 MiB static binary is far cheaper than a
# switch that can only be used wrong. Pin RTK_VERSION deliberately — an image build fails loudly on a bad asset.
ENV RTK_VERSION=0.44.0
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) target="x86_64-unknown-linux-musl" ;; \
      aarch64) target="aarch64-unknown-linux-gnu" ;; \
      *) echo "rtk: unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-${target}.tar.gz" -o /tmp/rtk.tar.gz; \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin rtk; \
    rm /tmp/rtk.tar.gz; \
    chmod +x /usr/local/bin/rtk; \
    rtk --version
# The VPN command the agent's vpn skill teaches and an owner can run in a terminal. It calls the daemon's /vpn
# routes (never a VPN client directly), so agent-initiated and UI-initiated connects are the same operation.
# The clients themselves are NOT baked — they ride the vpn capability's environment fragment, like WireGuard
# always has, so a sandbox with no VPN carries neither the tooling nor the privileges.
COPY --chmod=755 _apps/sandbox/bin/vpn /usr/local/bin/vpn
# Entrypoint starts sshd (for Mutagen sync) then execs the daemon as PID 1.
COPY _apps/sandbox/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
WORKDIR /work
# LANG: without a UTF-8 locale zsh's line editor counts BYTES as columns, so bira's multibyte prompt glyphs
# (╰─, ↵) desync the cursor and corrupt the prompt after any non-zero exit status. C.utf8 is glibc-built-in.
ENV WORKSPACE_ROOT=/work SANDBOX_PORT=8787 LANG=C.utf8 IQ_MODEL_DIR=/opt/iq-models IQ_PLUGIN_DIR=/opt/iq-plugin EXTENSIONS_DIR=/opt/extensions
# The bundled translator's fixed localhost endpoint + a loopback-only bearer (the token is just what Claude Code
# must send as ANTHROPIC_AUTH_TOKEN to a same-host proxy). Baked so config.translator.url is set in the image; a
# bare `tsx watch` dev run leaves both empty ⇒ no translator, and routed (codex/grok-under-Claude-Code) turns
# surface streamAgent's clean "no translator" error. The port is TRANSLATOR_PORT (@intentic/constants) — every
# fixed bind in this container is declared there and asserted distinct, because this line once read 8788 and
# silently fought the loopback listener for it. container-ports.test.ts holds the two in step.
ENV TRANSLATOR_URL=http://127.0.0.1:8789 TRANSLATOR_TOKEN=intentic-translator-local
# Privacy hardening for every agent CLI the daemon spawns (they all inherit process.env): telemetry, error
# reporting, feedback uploads, and update checks off — the CLIs are version-pinned in this image, so an update
# probe is pure phone-home. DO_NOT_TRACK covers Claude Code and anything else honoring the convention; Codex
# reads no env switches at all (its equivalents live in CODEX_HOME/config.toml — codex/codex-config.ts).
ENV DO_NOT_TRACK=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_FEEDBACK_COMMAND=1 \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1
# Toolchain-wide telemetry opt-outs for everything that runs in the sandbox — the agent's Bash tool, the web
# terminals' zsh, and any install/build/dev command in /work inherit this env. Tools not baked into the image
# are covered on purpose: the agent installs toolchains at will, and an unused var is inert. Each name is the
# tool's own documented switch; folk-list vars that don't exist (VITE_/PODMAN_/DOCKER_CLI_ telemetry opt-outs,
# CRATES_EDITION_METRICS) are omitted, as is ANSIBLE_GATHERING=explicit — that changes playbook semantics, not
# privacy. npm audit/fund are off because install-time audit posts the dependency graph to the registry.
# NOTE: containers under the sandbox's inner dockerd do NOT inherit this env — only processes in the sandbox itself.
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
