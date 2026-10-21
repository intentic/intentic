# Devin's own CLI, `devin`, which the daemon spawns as `devin acp` to serve a Devin turn over the Agent Client
# Protocol (runtimes/devin/). The npm package is a small Node launcher whose native binary (~190 MB) arrives as the
# one platform package npm picks for this machine.
#
# CLOSED SOURCE, like the Cursor pack, and a pack for the same reason: its licence points at Cognition's terms,
# which grant no redistribution, so it must never ride a published image. Deliberately absent from
# image-packs/profiles.json. The explicit Connect action installs this exact pin into the engine store for the
# sign-in; once a Devin account is connected, the overlay rebuild the owner approves bakes the same copy into
# their own image (runtimes/devin/devin-provider.ts `packs` gates it on that account being on disk).
#
# The native binary itself is linked onto PATH, not the launcher: engines/engine-resolve.ts finds the image's copy
# there, and a process the daemon kills is then the one holding the session rather than a wrapper around it.
# ponytail: engines.json blesses this pin; bump-engines.mjs moves both.
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefix /opt/devin --no-save --no-package-lock --no-audit --no-fund devin@3000.11.92 \
    && ln -sf "/opt/devin/node_modules/devin-linux-$(node -p 'process.arch')/bin/devin" /usr/local/bin/devin \
    && devin --version
