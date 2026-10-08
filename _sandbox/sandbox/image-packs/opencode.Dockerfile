# The `opencode` CLI (OpenCode 2), behind Grok and Gemini turns. The OpenCode service (runtimes/opencode/opencode.ts)
# spawns `opencode serve` itself and drives it with @opencode/client. OpenCode keeps its credentials and sessions in
# SQLite under XDG_DATA_HOME, which the service pins to the workspace's .intentic so they survive restarts. Pinned in
# lockstep with @opencode/client, because a version skew surfaces as server-API and event-shape errors;
# packs.integration.test.ts holds the two in step.
# The package lists every platform build as an optional dependency, and npm fetches all four for this machine's OS and
# CPU (glibc and musl, regular and baseline), about 200 MB each. Its postinstall links the build this machine runs into
# @opencode/cli/bin, after which the build packages are dead weight; they are removed in the same layer so they never
# reach the image.
# ponytail: bump together with @opencode/client.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @opencode/cli@2.0.26 \
    && test -x "$(npm root -g)/@opencode/cli/bin/opencode.exe" \
    && rm -rf "$(npm root -g)"/@opencode/cli/node_modules/@opencode/cli-* "$(npm root -g)"/@opencode/cli-* \
    && opencode --version
# Defaults in the GLOBAL config for the `opencode` a person or an agent runs by hand in the sandbox. The daemon's own
# server gets its config inline and ignores this file. No auto-update, because the CLI is version-pinned above, and no
# sharing. service.json stops the CLI starting OpenCode 2's shared background server, which would otherwise outlive the
# command that started it, run as a second copy beside the daemon's, and hold its own copy of every credential.
RUN mkdir -p /root/.config/opencode \
    && printf '{ "update": "disable", "share": "disabled" }\n' > /root/.config/opencode/opencode.json \
    && printf '{ "disabled": true }\n' > /root/.config/opencode/service.json
