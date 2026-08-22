# pi capability: the Pi coding agent CLI, so the daemon can spawn `pi --mode rpc` as a chat provider.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @earendil-works/pi-coding-agent
