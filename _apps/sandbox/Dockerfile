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
LABEL org.opencontainers.image.source=https://gitlab.com/radarsu/intentic
# procps gives the interactive terminal (system/terminal.ts) real process tools — `ps`, `top`, `kill` — so the
# owner can see what's running in the sandbox and reap a stuck dev command. zsh is the terminal's shell (below).
# tmux backs the terminal's sessions: each web tab attaches a tmux session, and the tmux server outlives the
# WebSocket, so a page reload / drop detaches (session + its running processes survive) instead of killing them.
# curl + jq back the CLI-tool integrations (e.g. the Discord `cli` capability's skill has the agent call
# Discord's REST API with `curl … | jq`); neither is in the slim base and the build stage's curl doesn't carry over.
# openssh-server is the transport for the local-sync feature: Mutagen on the laptop connects over SSH (through the
# sandbox's Cloudflare tunnel) to block-delta sync /work. Key-only (config drop-in below); host keys baked here.
# openssh-client + sshpass + rsync back the `ssh` capability: the agent runs `ssh <alias>` / `rsync` against
# connected machines, with sshpass -f for the password-auth ones. iproute2 gives `ip`/`ss` diagnostics.
# Heavy or privilege-coupled capability tools (WireGuard, whisper.cpp) are NOT baked here — each capability
# carries a Dockerfile fragment the daemon composes into the sandbox's environment overlay on enable
# (see capabilities/capability.ts `fragment`), applied by an owner-run rebuild.
# python3 + make + g++ are the node-gyp toolchain: runtime `pnpm install` (ensure-intent.ts, scaffold
# inject-template.ts, or a dev in /work) compiles native deps from source — node-pty ships no linux
# prebuild, so it ALWAYS builds here. Uncommon toolchains (cmake, -dev headers) stay an overlay concern.
# ripgrep backs the iq search CLI's lexical engine (iq-engine shells into `rg --json`).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates procps tmux zsh ncurses-term curl jq openssh-server openssh-client sshpass rsync iproute2 python3 make g++ ripgrep \
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
RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh \
    && ssh-keygen -A \
    && printf '%s\n' 'PasswordAuthentication no' 'PermitRootLogin prohibit-password' 'PubkeyAuthentication yes' > /etc/ssh/sshd_config.d/intentic.conf
# The terminal (system/terminal.ts) launches zsh with the oh-my-zsh "bira" theme + zsh-autosuggestions, so the
# owner gets a real prompt and history autocomplete. Installed into root's home (the daemon/terminal run as
# root); --depth=1 tracks the default branch (pin to a commit if reproducibility matters).
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
        'source $ZSH/oh-my-zsh.sh' \
        > /root/.zshrc
# tmux backs each terminal tab (system/terminal.ts attaches one session per tab). The web UI draws the tab bar,
# so the tmux status bar is off; default-command launches the oh-my-zsh zsh above (not /bin/sh); destroy-unattached
# off keeps a session alive when its web client detaches on reload/drop — the whole point of tmux-backed persistence.
# Mouse stays OFF: on, tmux grabs the wheel into copy-mode and every scroll redraws the screen under the
# browser's local selection, so a selection could never survive scrolling or span more than one screenful. Off,
# xterm scrolls its own scrollback and selection is native; full-screen apps that request mouse tracking still
# get it (tmux forwards the active pane's mouse mode to the client), and the deep history stays reachable via
# prefix copy-mode, whose `y` lands in the browser clipboard through set-clipboard/OSC 52 below.
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
# The `opencode` CLI on PATH — the Grok provider (grok/opencode.ts) spawns `opencode serve` via
# @opencode-ai/sdk's createOpencodeServer, which shells out to this binary. xAI OAuth tokens are persisted by
# OpenCode under XDG_DATA_HOME, which the service pins to the workspace's .intentic so they survive restarts.
# The agent's shell also drives it directly (`opencode run`) to delegate tasks to Grok (agent/delegation.ts).
# Pin the CLI in lockstep with the SDK version in _apps/sandbox/package.json so the client/server wire API matches.
# ponytail: bump this together with @opencode-ai/sdk; a version skew surfaces as server-start / event-shape errors.
RUN npm install -g opencode-ai@1.17.15 && opencode --version
# OpenCode privacy defaults, in the GLOBAL config (the only level where autoupdate:false is honored): no
# auto-update (the CLI is version-pinned above) and no session sync to opncd.ai, even manual /share. The
# daemon's server-spawn config (grok/opencode.ts) merges over this file, so runtime overrides are unaffected.
RUN mkdir -p /root/.config/opencode \
    && printf '{ "autoupdate": false, "share": "disabled" }\n' > /root/.config/opencode/opencode.json
# The `codex` CLI on PATH — the agent's shell delegates tasks to the user's connected Codex account
# (`codex exec`, agent/delegation.ts), authenticated via the CODEX_HOME injected per turn. Pin in lockstep
# with @openai/codex-sdk in _apps/sandbox/package.json (the Codex primary adapter), same rationale as opencode.
RUN npm install -g @openai/codex@0.142.5 && codex --version
# The `cli-proxy-api` binary on PATH — CLIProxyAPI, the Anthropic↔OpenAI/xAI translator that lets the Claude Code
# harness drive Codex/Grok on the user's SUBSCRIPTION OAuth: agent/translator.ts spawns it as the server (a routed
# turn's ANTHROPIC_BASE_URL points at it), and its device-code logins (--codex-device-login / the xAI Management
# flow) connect the subscriptions. A prebuilt Go release, pinned like the npm CLIs above.
# ponytail: bump the pin deliberately; a wire-API or Management-endpoint change surfaces as a translator-only
# failure (native-harness turns never touch it).
ARG CLIPROXY_VERSION=7.2.85
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && arch="$(dpkg --print-architecture)" \
    && mkdir -p /tmp/cliproxy \
    && curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY_VERSION}/CLIProxyAPI_${CLIPROXY_VERSION}_linux_${arch}.tar.gz" | tar -xz -C /tmp/cliproxy \
    && install -m 0755 "$(find /tmp/cliproxy -type f -name cli-proxy-api | head -n1)" /usr/local/bin/cli-proxy-api \
    && test -x /usr/local/bin/cli-proxy-api \
    && rm -rf /tmp/cliproxy /var/lib/apt/lists/*
# cloudflared on PATH — `intentic apply` shells out to `cloudflared access tcp` to reach a self-host's SSH
# through its Cloudflare tunnel when the host is registered with via:"cloudflared" (a NAT'd local machine).
# Pinned to the same version connect.sh runs as the tunnel sidecar. Placed HERE, before the tree COPYs below,
# so the layer stays cache-stable across source changes.
ARG CLOUDFLARED_VERSION=2026.7.2
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}" -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && /usr/local/bin/cloudflared --version
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
# The lsp CLI on PATH — the agent's TypeScript rename + diagnostics tool, gated by the lspTools setting (the
# daemon writes/removes its skill at /work/.claude/skills/lsp). Standalone: it drives the TS language service
# (its own bundled typescript) over whatever tsconfig project the agent points it at in /work. Same chmod +
# symlink rationale as iq/intentic — tsc keeps the file's shebang, so the linked cli.js runs directly.
COPY --from=trees lsp /opt/lsp
RUN chmod +x /opt/lsp/dist/cli.js \
    && ln -s /opt/lsp/dist/cli.js /usr/local/bin/lsp
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
RUN npm install -g node-gyp \
    && cd /opt/sandbox/node_modules/.pnpm/node-pty@*/node_modules/node-pty \
    && node-gyp rebuild \
    && cd /opt/sandbox/node_modules/.pnpm/@discordjs+opus@*/node_modules/@discordjs/opus \
    && rm -rf prebuild build-tmp-napi-v3 \
    && npm run install
# Image-baked first-party extensions — one manifest checkout per subdir, enumerated by installedExtensions()
# via SANDBOX_EXTENSIONS_DIR (the iq-plugin precedent): present in every sandbox, not removable, no capability
# entry. connectors is data-only (manifest + connector skills + client image fragments) so it copies straight
# from context; discord and imap ship their deployed gateway trees from the trees context (node_modules included).
# The web-builtin UI extensions (automations, logs, …) are NOT baked — they compile into the web bundle and
# contribute nothing daemon-side; rtk stays a git-install (its environment fragment only composes for
# extension-kind capability entries, so baking it would be inert).
COPY _extensions/connectors /opt/extensions/connectors
COPY --from=trees extensions/discord /opt/extensions/discord
# Same glibc rationale as the sandbox rebuild above — the discord gateway's voice stack compiles opus from source.
RUN cd /opt/extensions/discord/node_modules/.pnpm/@discordjs+opus@*/node_modules/@discordjs/opus \
    && rm -rf prebuild build-tmp-napi-v3 \
    && npm run install
COPY --from=trees extensions/imap /opt/extensions/imap
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
# surface streamAgent's clean "no translator" error.
ENV TRANSLATOR_URL=http://127.0.0.1:8788 TRANSLATOR_TOKEN=intentic-translator-local
# Privacy hardening for every agent CLI the daemon spawns (they all inherit process.env): telemetry, error
# reporting, feedback uploads, and update checks off — the CLIs are version-pinned in this image, so an update
# probe is pure phone-home. DO_NOT_TRACK covers Claude Code and anything else honoring the convention; Codex
# reads no env switches at all (its equivalents live in CODEX_HOME/config.toml — codex/codex-credentials.ts).
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
