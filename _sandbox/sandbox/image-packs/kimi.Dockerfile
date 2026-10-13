# Kimi Code CLI, `kimi`, which the daemon spawns as `kimi acp` to serve a Kimi turn on the CLI's own loop over the Agent
# Client Protocol (runtimes/kimi-cli/). MIT-licensed on npm, so a published image could carry it; it is a pack rather
# than part of the standard profile because only a sandbox that signs a Kimi account into the CLI ever runs it (the
# translator serves Kimi under Claude Code without it). Connect installs this pin into the engine store for the sign-in,
# and once an account is on disk the owner's overlay bakes the same copy (runtimes/kimi-cli `packs`).
# The CLI updates itself unless told not to; the daemon sets KIMI_CODE_NO_AUTO_UPDATE on every process it starts, so the
# pin below is the version that runs.
# ponytail: engines.json blesses this pin; bump-engines.mjs moves both.
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefix /opt/kimi --no-save --no-package-lock --no-audit --no-fund @moonshot-ai/kimi-code@2.1.1 \
    && ln -sf /opt/kimi/node_modules/.bin/kimi /usr/local/bin/kimi \
    && kimi --version
