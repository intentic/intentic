# @intentic/ext-acp-agents

The coding agents you can run in a sandbox besides Claude — OpenCode, Gemini, and any other ACP-speaking agent.

## Responsibilities

- Declare the agent capabilities, so the fleet can offer them as a choice of who runs a turn.

## Key files

- [intentic-extension.json](intentic-extension.json) — the three capabilities. This file IS the package; there is
  no `src/` and no skills directory.
- [package.json](package.json) — the manifest that makes it a package at all.

## How it fits

ACP is the Agent Client Protocol: one wire format several agent vendors speak. `_sandbox/acp-bridge` is what
actually talks it; this package is the declaration that makes those agents selectable.

The generic `acp-agent` capability is the interesting one — it is how an agent this repo has never heard of
becomes available without a code change here.

## Conventions & gotchas

- The smallest package in the repository, and deliberately so. A capability that needs logic is not a capability.
