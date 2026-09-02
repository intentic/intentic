# The CORE sandbox image — the floor: what the daemon and its web workspace need to function, nothing else.
# Everything heavier (Chromium, Docker Engine, provider CLIs, semantic-search models, messaging gateways) is a
# FEATURE PACK: a checked-in fragment under packs/ that _tools/scripts/compose-image-dockerfile.mjs splices at
# the two marker lines below to build a published profile (packs/profiles.json — `standard` is what
# ghcr.io/intentic/sandbox:stable ships), and that the daemon composes into the environment overlay when a
# capability needs it on demand (src/environment/packs.ts). Same fragment files both ways, so the baked and
# on-demand paths cannot drift; a splice stamps /opt/packs/<name> so the daemon knows what its base carries.
#
# The monorepo is compiled OUTSIDE Docker: _tools/scripts/prepare-image-trees.sh builds the baked packages
# (turbo, warm cache) and prunes their production trees into .image-out/, which enters this build as the named
# context `trees`. Every layer here is a pinned tool install (registry-cache-stable) or a cheap tree COPY, so a
# source change rebuilds in seconds — no pnpm install / turbo run inside a cacheless container. Build from the
# REPO ROOT (the main context still carries the source-copied bits — iq plugin, skills, bin scripts,
# entrypoint, connectors):
#   bash _tools/scripts/prepare-image-trees.sh
#   node _tools/scripts/compose-image-dockerfile.mjs standard > .image-out/Dockerfile.standard
#   docker build --build-context trees=.image-out -f .image-out/Dockerfile.standard -t ghcr.io/intentic/sandbox .
# (or build this file directly for the bare core profile). At run time connect.sh / the workspace provider
# inject agent credentials (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) and mount the workspace volume at
# /work — neither is baked into the image.

FROM node:24.18.0-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS runtime
# Links the GHCR package to the repo (inherits its visibility/permissions, shows under its Packages).
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

# THE BUILD-CACHE CONTRACT, set once here and relied on by every apt block downstream: in this file, in every
# feature pack, and in every environment-overlay fragment. Each of those mounts /var/cache/apt and
# /var/lib/apt/lists as BuildKit caches, so a re-run that misses the layer cache still does not re-download.
# That matters because an overlay is `FROM` this image: publishing a new sandbox image changes this image's
# digest, which invalidates EVERY overlay layer above it, so a sandbox re-installs its whole environment on
# every update. The layer miss is unavoidable (the parent chain really did change); paying for the bytes twice
# is not. _tools/scripts/build-cache-mounts.mjs enforces the mounts, and enforcement is what makes removing
# docker-clean safe: Debian's drop-in deletes the archives after each install, which would empty the very cache
# mount it is meant to fill, but with it gone an UNMOUNTED apt block would commit its .debs into the image.
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
    && printf 'Binary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/99intentic-keep-downloads
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
# Heavy or privilege-coupled capability tools (WireGuard) are NOT baked here — each capability carries a
# Dockerfile fragment the daemon composes into the sandbox's environment overlay on enable (see
# capabilities/capability.ts `fragment`), applied by an owner-run rebuild. whisper.cpp graduated out of that
# set into the `whisper` feature pack (composer voice input needs it on every standard image); Discord's
# connector NAMES that pack rather than shipping its own copy of the build, so a standard image composes
# nothing for it (see the pack's own header).
# python3 + make + g++ are the node-gyp toolchain: runtime `pnpm install` (ensure-intent.ts, scaffold
# inject-template.ts, or a dev in /work) compiles native deps from source — node-pty ships no linux
# prebuild, so it ALWAYS builds here. Uncommon toolchains (cmake, -dev headers) stay an overlay concern.
# ripgrep backs the iq search CLI's lexical engine (iq-engine shells into `rg --json`).
# python3-pip + python3-venv: python3 was already here for node-gyp, but with no way to INSTALL anything an
# agent reaching for ordinary Python tooling (Pillow to inspect a screenshot, a one-off script's dependency)
# hit `pip: command not found` and improvised. Debian marks the system interpreter externally-managed, so
# `pip install` outside a venv refuses by design — venv is what makes pip usable rather than merely present.
# python3-yaml + python3-pil are baked from Debian rather than left to pip BECAUSE of that refusal: an import
# an agent reaches for mid-task cannot afford a venv detour first. Measured over 1146 session transcripts,
# a missing import is the ONLY common Python failure here — 60 sessions, ~1 in 8 of those that run python3,
# and it is PyYAML (36 sessions) and Pillow (24) almost exclusively; every other module is a one-off. The
# failure is not a retry, it is a silent detour: 6 times in 10 the agent abandons Python and redoes the work
# in Node. yq (below) was baked for the YAML case and did not move the number — agents keep importing yaml,
# so the fix has to BE the import, not an alternative to it. Debian's packages sidestep PEP 668 entirely.
# python-is-python3 for the rarer sibling: `python` unqualified is only 2 sessions in 1146, but both came
# from runners that are not this image's usual agent (a delegated CLI, a loop attempt) writing `python -m`
# out of habit, and Debian ships no such name. One package ends a whole class of no-such-command.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates procps tmux zsh ncurses-term curl jq openssh-server openssh-client sshpass rsync iproute2 python3 python3-pip python3-venv python-is-python3 python3-yaml python3-pil make g++ ripgrep
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
#
# THE TWO HOOKS AT THE END ARE WHAT MAKES THE PANEL'S BUSY DOT LIVE. tmux tells nobody when a command starts or
# stops inside a live pane — `pane_current_command` just reads differently the next time somebody asks — so the
# daemon could only ever sample it, and the dot outlived the command by up to a poll. The shell knows the exact
# moment, and it is our shell: preexec (a command is about to run) and precmd (a prompt is about to be drawn)
# truncate one file in /run, which the daemon watches (terminal/prompt-signal.ts) and turns into a `terminals`
# frame. Two syscalls and no fork, so it costs nothing per prompt; the braces put the redirection failure on
# the group's stderr, so a missing /run/intentic/shell (no daemon has listened yet) is silent rather than a
# line of noise above every prompt. They come after oh-my-zsh's source line because add-zsh-hook composes with
# whatever omz and zsh-autosuggestions register there, and last-registered is simply last-run.
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
        'autoload -Uz add-zsh-hook' \
        '_intentic_prompt_signal() { { : >| /run/intentic/shell/prompt; } 2>/dev/null }' \
        'add-zsh-hook preexec _intentic_prompt_signal' \
        'add-zsh-hook precmd _intentic_prompt_signal' \
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
# The two mouse bindings BELOW the wheel are unbound for the same reason the status bar is off: in a browser
# they are someone else's job. tmux's default right-click draws its own pane menu (splits, kill, respawn) INSIDE
# the terminal, over the top of the browser context menu the panel puts there — and it is drawn at the pane's
# idea of the pointer, on rows the user cannot click away from. Its default middle-click pastes tmux's OWN
# buffer, which in a browser session is stale or empty and never the thing the user just copied. Both gestures
# belong to the web client, which has the real clipboard and the real menu; the wheel stays tmux's.
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
        'unbind -n MouseDown3Pane' \
        'unbind -n MouseDown2Pane' \
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
RUN corepack enable && corepack prepare pnpm@12.1.0 --activate \
    && find "$HOME/.cache/node/corepack" -path '*node-gyp/gyp/gyp_main.py' -exec chmod +x {} +
# node-gyp on PATH, for the native rebuild that runs after the tree COPYs below (node-pty) and
# for an agent compiling a native dep by hand. Installed HERE, above those COPYs, because it used to share the
# rebuild's RUN — where every source change re-downloaded it, unpinned, before any compiling started. Pinned
# like every other tool in this image so a bad upstream release fails a deliberate bump, not the next pipeline.
# ponytail: bump alongside the node base image — node-gyp tracks the headers it compiles against.
#
# EVERY `npm install` IN THIS FILE MOUNTS ~/.npm AS A BUILD CACHE. npm keeps the downloaded tarball in
# ~/.npm/_cacache next to the package it unpacked, and cacache stores it exactly as the registry served it —
# already gzipped — so a layer that KEEPS that directory pays for the same bytes twice in every pull, and the
# second copy barely compresses. Measured in the published image: 420 MiB of tarballs left behind by the global
# installs and another 45 MiB by the playwright layer, ~23% of a 2 GB pull, for a cache nothing reads at runtime
# (installs in /work are pnpm's, and its store lives on the volume).
#
# These installs used to end in `npm cache clean --force` for that reason. A cache MOUNT is strictly better and
# replaces it: mounted content is never committed to a layer, so the image is just as small, and the tarballs
# survive for the next build instead of being thrown away — which matters because every layer here re-runs
# whenever the image's own base or an earlier layer moves. Cleaning it now would only empty the mount.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g node-gyp@13.0.1 && node-gyp --version
# The provider CLIs — `opencode` (Grok), `cli-proxy-api` (the subscription translator) and `codex` — are
# feature packs: connected-provider state decides whether each rides the overlay (environment/provider-packs.ts),
# and the standard profile bakes them all.
# cloudflared, for one job that has nothing to do with how this sandbox is reached: `intentic deploy apply`
# shells out to `cloudflared access tcp` to reach a self-host's SSH through the USER'S own Cloudflare tunnel
# (via:"cloudflared" hosts). It used to share this spot with a `zrok2` binary that WAS the reachability
# fabric; that fabric is the platform's own edge now, which the daemon dials over an outbound WebSocket with
# no binary to install (sandbox-contract/ingress-contract.ts). Placed HERE, before the tree COPYs below, so
# the layer stays cache-stable across source changes.
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
ARG YQ_VERSION=4.53.3
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${arch}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version
# ---- packs:pre-trees ---- (spliced by compose-image-dockerfile.mjs — pinned pack installs land here, ABOVE
# the tree COPYs, so a source change never evicts a pack download; the core profile carries none)
# The intentic CLI on PATH — the /intentic endpoint shells out to it for resolve/plan dry-runs, and
# connect.sh runs it via `--entrypoint intentic`. tsc emits cli.js without the exec bit, so chmod it:
# runc resolves the entrypoint with Go's exec.LookPath, which reports a non-executable PATH entry as
# "executable file not found in $PATH".
COPY --from=trees cli /opt/intentic-cli
RUN chmod +x /opt/intentic-cli/dist/cli.js \
    && ln -s /opt/intentic-cli/dist/cli.js /usr/local/bin/intentic
# THE STARTER SITE, built here so a new sandbox never builds it. A fresh workspace used to open empty, with
# nothing running and nothing to look at; the daemon's first boot now copies this tree into /work and starts its
# dev server (src/scaffold/starter-site.ts), so the preview is live seconds after the machine is. The install is
# the whole reason this is baked: it takes a minute or two and cannot be made shorter, so it is paid once, at
# image build time, instead of on every new user's clock.
#
# Built by the SAME CLI the Add-app button runs — one code path, so the baked starter and a hand-added landing
# app cannot drift — and installed INSIDE the image, so every native dependency matches this platform rather
# than whichever host prepared the trees. The `.git` the scaffold leaves behind is dropped: the daemon inits the
# repo itself when it seeds it, with the git dir on /history like every other workspace repo. Pinned by ref so a
# template push cannot silently change what an image built yesterday ships.
ARG STARTER_TEMPLATE_REF=main
RUN intentic scaffold monorepo --dir /opt --name starter --ref "$STARTER_TEMPLATE_REF" \
    && intentic scaffold add-app --dir /opt/starter --apps landing --ref "$STARTER_TEMPLATE_REF" \
    && rm -rf /opt/starter/.git
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
# The sandbox daemon.
COPY --from=trees sandbox /opt/sandbox
# node-pty ships no linux prebuild, so it gets source-compiled by whatever host ran pnpm deploy — linked
# against THAT host's glibc. Rebuild it against this image's glibc with the baked toolchain (python3/make/g++
# above; the node image ships its own headers, so node-gyp compiles offline). Without this, a tree deployed on
# a newer-glibc dev box ships a binary this runtime can't load. Driven directly, not via `npm rebuild`:
# node-pty's npm install script wants tsc (its lib/ is already compiled in the tarball — only the .node needs
# building). The registry-prebuilt natives (sharp, ast-grep, onnxruntime, davey) are manylinux — safe as copied.
RUN cd /opt/sandbox/node_modules/.pnpm/node-pty@*/node_modules/node-pty \
    && node-gyp rebuild
# The lsp CLI on PATH — the agent's TypeScript rename + diagnostics tool, gated by the lspTools setting (the
# daemon writes/removes its skill at /work/.claude/skills/lsp). It runs the native TypeScript compiler (its
# bundled @typescript/native-preview binary) over whatever tsconfig project the agent points it at in /work.
# Every question — `lsp diag`, `lsp rename`, and the sandbox's post-edit hook — is a fresh compiler run that
# answers and exits; nothing stays resident, so a workspace pays memory only while a check is actually running.
#
# Symlinked out of the DAEMON'S tree rather than deployed as a tree of its own: @intentic/lsp is a dependency of
# @intentic/sandbox, so /opt/sandbox already contains this exact package (and its bundled native compiler) — a
# second `pnpm deploy` root shipped a 54 MiB duplicate of it, 14.6 MiB of the pull. Node resolves the CLI's
# imports from the target's realpath inside /opt/sandbox/node_modules, the pane-log-clean precedent below. The
# chmod is the intentic rationale — and it doubles as this layer's existence check: a tree that stopped carrying
# the package fails the build here instead of leaving `lsp` off PATH.
RUN chmod +x /opt/sandbox/node_modules/@intentic/lsp/dist/cli.js \
    && ln -s /opt/sandbox/node_modules/@intentic/lsp/dist/cli.js /usr/local/bin/lsp
# The iq search CLI on PATH — the agent's primary code-search tool (every backend's Bash tool inherits PATH)
# and the daemon's /workspace/search backend (execFile `iq --json`). Symlinked out of the daemon's tree exactly
# like lsp above: @intentic/iq is a dependency of @intentic/sandbox, so /opt/sandbox already carries it — a
# second `pnpm deploy` root shipped a ~450 MiB duplicate of the engine's node_modules (onnxruntime,
# transformers, ast-grep) for a CLI whose own code is under 1 MiB. Same chmod-as-existence-check rationale.
RUN chmod +x /opt/sandbox/node_modules/@intentic/iq/dist/cli.js \
    && ln -s /opt/sandbox/node_modules/@intentic/iq/dist/cli.js /usr/local/bin/iq
# The webq CLI on PATH — the agent's web-fetch tool (URL → clean budgeted markdown, bounded site crawls,
# shared 15-min cache). Symlinked out of the daemon's tree exactly like lsp and iq above: @intentic/webq is a
# dependency of @intentic/sandbox, so /opt/sandbox already carries it and its deps (parse5; playwright is the
# daemon's own copy). Uses the browser pack's Chromium when a page needs JS and degrades to static HTML with a
# notice when this image doesn't carry it. Same chmod-as-existence-check rationale.
RUN chmod +x /opt/sandbox/node_modules/@intentic/webq/dist/cli.js \
    && ln -s /opt/sandbox/node_modules/@intentic/webq/dist/cli.js /usr/local/bin/webq
# The fileq CLI on PATH — the agent's binary-file reader (docx/xlsx/pptx/pdf/images/audio → clean budgeted
# markdown, with content-hash-fresh sidecars under .intentic/local/cache/derived/). Symlinked out of the
# daemon's tree exactly like lsp, iq and webq above: @intentic/fileq is a dependency of @intentic/sandbox, and
# the daemon's sidecar service (src/derived/) spawns this very binary for the background pass the `sidecars`
# setting gates. The skill that teaches agents it exists rides settings/skills.ts, not a plugin dir.
RUN chmod +x /opt/sandbox/node_modules/@intentic/fileq/dist/cli.js \
    && ln -s /opt/sandbox/node_modules/@intentic/fileq/dist/cli.js /usr/local/bin/fileq
# The `codex` CLI is the codex feature pack (a global install pinned to @openai/codex-sdk's exact dependency —
# packs/codex.Dockerfile): prepare-image-trees.sh prunes the ~350 MiB @openai/codex platform package OUT of the
# daemon tree, so the pack's copy is the only one and the daemon directly spawns its app-server surface.
# Image-baked first-party extensions — one manifest checkout per subdir, enumerated by installedExtensions()
# via SANDBOX_EXTENSIONS_DIR (the iq-plugin precedent): present in every sandbox, not removable, no capability
# entry. connectors, social, computers, acp-agents and pi-agent are data-only (manifest + skill packs + client
# image fragments) so they copy straight from context. The gateway extensions (discord, imap, slack, telegram,
# whatsapp, google-workspace) bake their MANIFESTS here — the cards exist in every image — while their deployed
# runtime trees are the bake-only `messaging` feature pack (packs/messaging.Dockerfile, in the standard
# profile); on a core image the daemon surfaces "not included in this image" instead of spawning a runtime that
# isn't there. google-workspace is in that group for its `bin` as much as its watcher: the manifest promises
# both, and extensionRuntimeAbsent is all-or-nothing per extension, so shipping the CLI from context here would
# make the watcher's absence on a core image invisible rather than stated.
#
# The five data-only packs are what makes the /capabilities grid: every card that is a ROW over a generic core
# handler (a cli connector, a social platform, an OS pack, an ACP preset, the Pi agent) is one of these manifest
# entries, so switching a pack off removes exactly its cards. Miss a COPY and those cards silently vanish from
# the grid.
COPY _extensions/connectors /opt/extensions/connectors
COPY _extensions/social /opt/extensions/social
COPY _extensions/computers /opt/extensions/computers
COPY _extensions/browsers /opt/extensions/browsers
COPY _extensions/acp-agents /opt/extensions/acp-agents
COPY _extensions/pi-agent /opt/extensions/pi-agent
COPY _extensions/discord/intentic-extension.json /opt/extensions/discord/
COPY _extensions/imap/intentic-extension.json /opt/extensions/imap/
COPY _extensions/slack/intentic-extension.json /opt/extensions/slack/
COPY _extensions/telegram/intentic-extension.json /opt/extensions/telegram/
COPY _extensions/whatsapp/intentic-extension.json /opt/extensions/whatsapp/
COPY _extensions/google-workspace/intentic-extension.json /opt/extensions/google-workspace/
# documentation is a UI extension with daemon-side contributions, so it sits between the two groups: its views are
# compiled into the web bundle like the manifest-only ones below, but `contributes.bin` (the intentic-docs CLI the
# agent runs) and `contributes.agent` (the documenting skill) are read from the image, so those two directories have
# to be here or the CLI never reaches the agent's PATH and the skill never loads. Straight from context rather than
# the trees stage: both are dependency-free — plain ESM and markdown — so there is no node_modules to deploy. `src/`
# is deliberately not copied; that is the web bundle's half.
#
# --chmod=755 ON EVERY `contributes.bin` DIRECTORY, and it is not cosmetic. The daemon prepends these directories
# to the agent's PATH each turn, and PATH resolution skips a file without the execute bit — so `intentic-docs`
# shipped as mode 644, sat on PATH in every sandbox, and could not be run by the skill that announces it. The
# same was true of `discord-voice` and `whatsapp` (see packs/messaging.Dockerfile). A tool the agent is told it
# has and cannot invoke is worse than one it was never given.
COPY _extensions/documentation/intentic-extension.json /opt/extensions/documentation/
COPY --chmod=755 _extensions/documentation/bin /opt/extensions/documentation/bin
COPY _extensions/documentation/plugin /opt/extensions/documentation/plugin
# The web-builtin UI extensions bake their MANIFEST ONLY — their code is compiled into the web bundle
# (extension-host/builtins.ts), so there is nothing daemon-side to ship. The manifest is what makes them exist
# for the daemon: `GET /extensions` then enumerates EVERY first-party extension through one enumerator (a count
# is not written here — it was hand-maintained, and was already wrong by one before anyone noticed; the list in
# extensions.routes.integration.test.ts is what actually holds the invariant),
# so the Extensions tab is a complete list with a working on/off switch instead of a view of one load path.
# The pairing is checked both ways — a manifest here with no compiled-in module shows as "missing" in the tab
# (image and web bundle built from different commits), and a module with no manifest shows as "unlisted".
COPY _extensions/acceptance/intentic-extension.json /opt/extensions/acceptance/
COPY _extensions/activity/intentic-extension.json /opt/extensions/activity/
COPY _extensions/approvals/intentic-extension.json /opt/extensions/approvals/
COPY _extensions/automations/intentic-extension.json /opt/extensions/automations/
COPY _extensions/deployments/intentic-extension.json /opt/extensions/deployments/
COPY _extensions/issues/intentic-extension.json /opt/extensions/issues/
# …deployments ships a BACKEND bundle too (manifest `server`, run by the daemon's backend host), like memory below.
# From the trees context, like every other compiled artifact: the root context excludes **/dist, so the bundle is
# invisible to a COPY that reads the repo tree — however plainly it sits beside the manifest in the checkout.
COPY --from=trees extensions/deployments/dist /opt/extensions/deployments/dist
COPY _extensions/git-history/intentic-extension.json /opt/extensions/git-history/
COPY _extensions/knowledge/intentic-extension.json /opt/extensions/knowledge/
# …knowledge is the documentation shape plus a backend: its views compile into the web bundle, its `knowledge`
# skill (contributes.agent) is read from the image, and BOTH its compiled halves come from the trees context —
# the backend the host loads (manifest `server`) and the `kb` CLI the agent runs (contributes.bin). The CLI is
# built rather than hand-written because it drives the same vault engine the backend does, so the agent and the
# panel cannot disagree about what a note says; that is also why it is here and not a straight COPY like
# documentation's. The bin directory carries the exec bit — see the note above.
COPY _extensions/knowledge/plugin /opt/extensions/knowledge/plugin
# …and its Obsidian card's cheatsheet, which is NOT under plugin/ on purpose: everything in that directory is
# loaded every turn, and a skill teaching a vault nobody connected is context spent on a tool that isn't there.
# A `contributes.capabilities` skill is read from the checkout at connect time and written into the workspace
# for that instance instead, so it exists exactly while the card does.
COPY _extensions/knowledge/skills /opt/extensions/knowledge/skills
COPY --from=trees extensions/knowledge/dist/server.js /opt/extensions/knowledge/dist/
COPY --from=trees --chmod=755 extensions/knowledge/dist/bin /opt/extensions/knowledge/dist/bin
COPY _extensions/maintenance/intentic-extension.json /opt/extensions/maintenance/
COPY _extensions/pipelines/intentic-extension.json /opt/extensions/pipelines/
COPY _extensions/preview/intentic-extension.json /opt/extensions/preview/
COPY _extensions/repo-apps/intentic-extension.json /opt/extensions/repo-apps/
COPY _extensions/viewers/intentic-extension.json /opt/extensions/viewers/
COPY _extensions/workflows/intentic-extension.json /opt/extensions/workflows/
# ---- packs:post-trees ---- (spliced by compose-image-dockerfile.mjs — packs that read the daemon tree or
# COPY from the trees context land here, below every tree COPY they depend on)
# pane-log-clean on PATH — the tmux pipe-pane hooks (above / logs/log-files.ts) replay each pane's byte
# stream through it (a headless VT emulator using @xterm/headless from the daemon's node_modules) to keep
# the terminal logs readable. Symlinked like intentic/iq: node resolves @xterm/headless from the target's
# realpath (/opt/sandbox/node_modules); tsc keeps the file's shebang, so chmod +x makes it directly runnable.
RUN chmod +x /opt/sandbox/dist/logs/pane-log-clean.js \
    && ln -s /opt/sandbox/dist/logs/pane-log-clean.js /usr/local/bin/pane-log-clean
# The memory half of the same queue, symlinked the same way and for the same reason: it is the daemon's OWN
# admission policy (src/platform/memory-admission.ts, the numbers that refuse a turn) run as a command, so
# queue-run can hold a suite off a pinned box without the policy being written down twice. Fails open on every
# path, including this binary being absent.
RUN chmod +x /opt/sandbox/dist/platform/memory-gate.js \
    && ln -s /opt/sandbox/dist/platform/memory-gate.js /usr/local/bin/memory-gate
# Image-baked agent skills (the daemon runs as root; the agent's settingSources loads /root/.claude). The
# environment skill teaches the agent to extend this very image via an approved overlay Dockerfile; the
# intentic skill is the product's own reference, what the agent reads before it answers for the product.
COPY _sandbox/sandbox/skills /root/.claude/skills
# The tmux command runner — the agent's PreToolUse hook (src/agent/agent-terminals.ts) wraps every Bash tool
# command through it, and the daemon's terminal runner (src/terminal/terminal-run.ts) executes user-triggered
# flows through it, so commands run live-visible in tmux sessions — and the agent's output filter, which
# strips noise from what the model sees.
COPY --chmod=755 _sandbox/sandbox/bin/tmux-run /usr/local/bin/tmux-run
# The heavy-command queue the same hook splices in front of a command matching a rule in
# .intentic/config/heavy-commands.json, so several sessions' test/typecheck fan-outs take turns instead of
# pinning the cgroup together (src/platform/heavy-commands.ts carries the measurement). It holds an flock, so
# `flock` (util-linux, already in the base) is its one dependency; a missing one degrades to running the
# command plainly. Not on PATH ⇒ the daemon never inserts it at all (terminal-run.ts queueRunEnabled).
COPY --chmod=755 _sandbox/sandbox/bin/queue-run /usr/local/bin/queue-run
COPY --chmod=755 _sandbox/sandbox/bin/agent-output-filter.mjs /usr/local/bin/agent-output-filter
# The cleaner registry the filter imports (./cleaners.mjs resolves next to the renamed binary at /usr/local/bin).
COPY --chmod=755 _sandbox/sandbox/bin/cleaners.mjs /usr/local/bin/cleaners.mjs
# retrieve-output on PATH — the reversible half of the filter (fetch back elided output; the footer names it).
COPY --chmod=755 _sandbox/sandbox/bin/retrieve-output.mjs /usr/local/bin/retrieve-output
# rtk is NOT baked. It was the alternate cleaner backend behind a `filterBackend` setting; that setting was
# removed after measurement (docs/output-cleaners.md, "Why there is one filter and not a choice of backend")
# and the behaviours worth keeping were ported into the native cleaners. What remains is a benchmarking tool,
# so it ships the way every other opt-in tool does — the git-installed `rtk` extension's environment fragment
# composes it into the overlay for an owner who asks. Nothing on this image execs it.
# The VPN command the agent's vpn skill teaches and an owner can run in a terminal. It calls the daemon's /vpn
# routes (never a VPN client directly), so agent-initiated and UI-initiated connects are the same operation.
# The clients themselves are NOT baked — they ride the vpn capability's environment fragment, like WireGuard
# always has, so a sandbox with no VPN carries neither the tooling nor the privileges.
COPY --chmod=755 _sandbox/sandbox/bin/vpn /usr/local/bin/vpn
# The geo-exit command the agent's geo skill teaches. Same shape as vpn: it calls the daemon's /exit routes,
# never tor or openvpn directly, so an exit the agent moves and one the owner moves are the same operation.
# The clients are NOT baked either — tor rides the exit capability's fragment (and only tor's, which is why a
# tor-only exit costs no container privileges at all).
# NAMED `geo` BECAUSE `exit` IS A SHELL BUILTIN: a binary called exit is unreachable from any command line
# (`exit list` exits the shell instead of running it). The capability and the routes keep the word.
COPY --chmod=755 _sandbox/sandbox/bin/geo /usr/local/bin/geo
# The one-time-code command connector skills teach for services whose write path asks for a 2FA code (npm
# publish --otp). Same shape as vpn: it calls the daemon's code mint and owns no totp logic, so the stored seed
# never reaches a shell — only codes that die within their period do.
COPY --chmod=755 _sandbox/sandbox/bin/otp /usr/local/bin/otp
# The premium-services command the services skill teaches: list the platform's priced catalog, run one on the
# owner's credits. Same shape as vpn/otp — it relays through the daemon and owns no economics; the member
# gate, the meter and the refund discipline are all platform-side.
COPY --chmod=755 _sandbox/sandbox/bin/services /usr/local/bin/services
# The capability-ask command the capabilities skill teaches: list what this sandbox can be connected to, and
# ask the owner in chat to connect one. Same shape as services — it relays through the daemon, which owns the
# consent card and the setup watch; the CLI connects nothing and reads no credential.
COPY --chmod=755 _sandbox/sandbox/bin/capabilities /usr/local/bin/capabilities
# The wallet command the wallet skill teaches: check the sandbox's USDC balance and pay x402-payable
# endpoints under the owner's policy. Same shape as services — it relays through the daemon, which owns the
# consent card and the ledger; the signing key lives with the platform and never enters this container.
COPY --chmod=755 _sandbox/sandbox/bin/wallet /usr/local/bin/wallet
# The child-agent command the spawn note teaches (src/children/spawn-note.ts): start a full agent on any
# connected provider from any runtime's shell, wait on it, list this conversation's children. Same shape as
# services — it relays through the daemon, which owns the engine, the budgets and the persona gate; the CLI
# spawns nothing itself and reads no credential.
COPY --chmod=755 _sandbox/sandbox/bin/agents /usr/local/bin/agents
# Entrypoint starts sshd (for Mutagen sync) then execs the daemon as PID 1.
COPY _sandbox/sandbox/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
WORKDIR /work
# LANG: without a UTF-8 locale zsh's line editor counts BYTES as columns, so bira's multibyte prompt glyphs
# (╰─, ↵) desync the cursor and corrupt the prompt after any non-zero exit status. C.utf8 is glibc-built-in.
ENV WORKSPACE_ROOT=/work SANDBOX_PORT=8787 LANG=C.utf8 IQ_MODEL_DIR=/opt/iq-models IQ_PLUGIN_DIR=/opt/iq-plugin WEBQ_PLUGIN_DIR=/opt/webq-plugin EXTENSIONS_DIR=/opt/extensions
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
