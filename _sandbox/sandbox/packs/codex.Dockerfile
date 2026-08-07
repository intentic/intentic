# The `codex` CLI — the agent's shell delegates tasks to the user's connected Codex account (`codex exec`,
# agent/delegation.ts), and the daemon's Codex adapter drives this same binary via codexPathOverride
# (codex/codex-agent.ts), so the pack and the adapter can never run different engines. The daemon tree
# deliberately does NOT carry @openai/codex (prepare-image-trees.sh prunes it — ~350 MiB the SDK only needs at
# spawn time); this global install is the one copy. Pinned to @openai/codex-sdk's exact dependency;
# packs.test.ts holds the two in step.
# ponytail: bump together with @openai/codex-sdk.
RUN npm install -g @openai/codex@0.146.0 && codex --version && npm cache clean --force
