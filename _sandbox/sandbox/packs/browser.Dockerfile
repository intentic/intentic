# Chromium for the agent's browser tools + Xvfb, the virtual display it runs HEADED on, + the two small tools
# that make that display WATCHABLE — one unit, because a browser that exists but can only run headless is
# useless here (the headless shell is fingerprinted and blocked by anti-bot WAFs, e.g. Reddit's "network
# security"; headed full Chromium under Xvfb looks like a real browser). Chromium launches with `--no-sandbox`
# (an app-level flag), so this pack asks for no runtime directive / container privilege — and must never name
# that token even in prose: the rebuild executors grep for it, comments included.
#
# ffmpeg and xdotool are the picture and the hands. The owner watching a browser is x11grab off its display,
# encoded as H.264 (browser/videocast.ts), and taking the wheel is XTEST driving that same display
# (browser/xinput.ts). Both live HERE rather than in the base image because that is where the thing they
# operate lives: a sandbox with no browser has no display to grab and nothing to click. The base image
# deliberately carries no ffmpeg for exactly this reason — "heavy and task-specific: capability or overlay" —
# and a browser capability is the task. xdotool is 126 kB and needs only libx11, which Chromium already pulled.
# ffmpeg is the weight (~200 MB with its codec libraries), and it is the price of the browser being watchable
# at all: the alternative measured ~10x the bandwidth for a tenth of the frame rate.
# The playwright version pins the chromium revision — it MUST be the one the daemon's own playwright resolves
# (browser-tools.ts hands chromium.executablePath() to @playwright/mcp), so installing the same version yields
# the same revision by construction. packs.integration.test.ts holds the pin to the daemon's playwright dependency.
# ponytail: bump together with the `playwright` catalog entry.
# THE HEADLESS SHELL IS DELETED IMMEDIATELY. `install chromium` fetches two browsers — chromium and
# chromium-headless-shell — and nothing here ever launches the shell: both MCP specs (browser-tools.ts, headed
# and --headless) pass --executable-path from chromium.executablePath(), which is the full browser, and
# browser-login.ts launches headed. If a future launch drops --executable-path or asks for the shell channel,
# this rm is what breaks it — restore the shell there rather than resolving a missing-browser error at runtime.
# The ms-playwright cache is NOT mounted, deliberately: the browser it holds is the payload, and it has to land
# in a layer. Only the npm side is cached (the playwright package `npx` fetches to do the installing), which is
# also why `npm cache clean` is gone — a mounted cache is never committed, so there is nothing left to clean.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.npm \
    npx --yes playwright@1.62.1 install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb ffmpeg xdotool \
    && rm -rf /root/.cache/ms-playwright/chromium_headless_shell-*
