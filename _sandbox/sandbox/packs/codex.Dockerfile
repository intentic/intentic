# The `codex` CLI — the agent's shell delegates tasks to the user's connected Codex account (`codex exec`,
# agent/delegation.ts), and the daemon directly spawns this same binary as `codex app-server --stdio`
# (codex/codex-app-server.ts), so delegation and native turns cannot run different engines. The daemon tree
# deliberately does NOT carry @openai/codex (prepare-image-trees.sh prunes the ~350 MiB platform package);
# this global install is the one copy. Pinned to @openai/codex-sdk's exact dependency;
# packs.integration.test.ts holds the two in step.
# ponytail: bump together with @openai/codex-sdk.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @openai/codex@0.147.0 && codex --version
