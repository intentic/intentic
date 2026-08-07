# The `opencode` CLI — the Grok provider (grok/opencode.ts) spawns `opencode serve` via @opencode-ai/sdk's
# createOpencodeServer, which shells out to this binary; xAI OAuth tokens are persisted by OpenCode under
# XDG_DATA_HOME, which the service pins to the workspace's .intentic so they survive restarts. The agent's
# shell also drives it directly (`opencode run`) to delegate tasks to Grok (agent/delegation.ts). Pinned in
# lockstep with @opencode-ai/sdk — a version skew surfaces as server-start / event-shape errors;
# packs.integration.test.ts holds the two in step.
# ponytail: bump together with @opencode-ai/sdk.
RUN npm install -g opencode-ai@1.18.10 && opencode --version && npm cache clean --force
# OpenCode privacy defaults, in the GLOBAL config (the only level where autoupdate:false is honored): no
# auto-update (the CLI is version-pinned above) and no session sync to opncd.ai, even manual /share. The
# daemon's server-spawn config (grok/opencode.ts) merges over this file, so runtime overrides are unaffected.
RUN mkdir -p /root/.config/opencode \
    && printf '{ "autoupdate": false, "share": "disabled" }\n' > /root/.config/opencode/opencode.json
