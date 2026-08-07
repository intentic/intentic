# Chromium for the agent's browser tools + Xvfb, the virtual display it runs HEADED on — one unit, because a
# browser that exists but can only run headless is useless here (the headless shell is fingerprinted and
# blocked by anti-bot WAFs, e.g. Reddit's "network security"; headed full Chromium under Xvfb looks like a
# real browser). Chromium launches with `--no-sandbox` (an app-level flag), so this pack asks for no runtime
# directive / container privilege — and must never name that token even in prose: the rebuild executors grep
# for it, comments included.
# The playwright version pins the chromium revision — it MUST be the one the daemon's own playwright resolves
# (browser-tools.ts hands chromium.executablePath() to @playwright/mcp), so installing the same version yields
# the same revision by construction. packs.test.ts holds the pin to the daemon's playwright dependency.
# ponytail: bump together with the `playwright` catalog entry.
# THE HEADLESS SHELL IS DELETED IMMEDIATELY. `install chromium` fetches two browsers — chromium and
# chromium-headless-shell — and nothing here ever launches the shell: both MCP specs (browser-tools.ts, headed
# and --headless) pass --executable-path from chromium.executablePath(), which is the full browser, and
# browser-login.ts launches headed. If a future launch drops --executable-path or asks for the shell channel,
# this rm is what breaks it — restore the shell there rather than resolving a missing-browser error at runtime.
RUN npx --yes playwright@1.62.1 install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /root/.cache/ms-playwright/chromium_headless_shell-* \
    && rm -rf /var/lib/apt/lists/* /root/.npm/_npx \
    && npm cache clean --force
