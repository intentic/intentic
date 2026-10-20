# pi capability: the Pi coding agent CLI, so the daemon can spawn `pi --mode rpc` as a chat provider.
# Pinned because an overlay layer is cached: unpinned, a sandbox whose layer was already built kept the version it first
# fetched while a fresh build took upstream's newest. The daily tool bump moves it (_tools/scripts/tools/tool-pins.mjs).
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @earendil-works/pi-coding-agent@1.3.0
