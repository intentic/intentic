# @intentic/sandbox-contract

The wire between the sandbox daemon and its browser client — change it here, and both sides follow.

Every route the daemon serves, every event it pushes, and every shape either side sends is declared once in this
package as an oRPC contract plus Zod schemas. The daemon implements the contract; the web app consumes it; a
mismatch is a type error rather than a runtime surprise.

## Responsibilities

- Declare the contracts, one file per subject area (`src/contracts/`).
- Declare the schemas every contract shares (`src/schemas.ts`).
- Declare the event union the daemon pushes over SSE (`src/events.ts`).
- Hold the small pieces of logic that BOTH sides must agree on rather than each deciding: the chore book,
  hostname and tunnel-id rules, session naming, terminal protocol, workspace state, runtime state.
- Define workflow designs and immutable run snapshots, including full model/account/harness pins, per-step spend
  ceilings, pinned repository bases, bounded report previews, and complete-report artifact paths.

## Key files

- [src/contracts](src/contracts) — one contract per area. Start with `agent.contract.ts` and `git.contract.ts`.
- [src/schemas.ts](src/schemas.ts) — the shared shapes; the biggest file here, and the one most changes touch.
- [src/events.ts](src/events.ts) — what the daemon pushes, and when.
- [src/workspace-state.ts](src/workspace-state.ts) and [src/runtime-state.ts](src/runtime-state.ts) — which
  changed file, and which moved runtime thing, makes which browser view stale. The workspace table also assigns
  each daemon-owned path its export lifecycle (`carry`, `secret`, `identity`, or `derived`), including the
  auth/session/cache/artifact roots, and marks the configuration slice the root repo TRACKS (`versioned` — the
  allowlist the git exclude rules are derived from, so a store added later is untracked until someone says
  otherwise). The daemon publishes the cause and the browser derives the consequence, so neither side keeps its
  own copy of the other's list.
- [src/chores](src/chores) — the chore book: definitions, applicability gates and verdicts, shared because the
  daemon computes the signals and the browser renders the judgement.
- [src/publish-drafts.ts](src/publish-drafts.ts) — the drafts publisher automation, shared for the chore book's
  reason by its three consumers: the daemon's seeder, the recipe gallery, and the drafts routes' instant fire.
- [src/workflow-faults.ts](src/workflow-faults.ts) and [src/output-fields.ts](src/output-fields.ts) — graph and
  structured-output invariants shared by the designer and daemon, including duplicate field-name rejection.
- [src/index.ts](src/index.ts) — the public surface.
- [src/contract-lock.ts](src/contract-lock.ts) and [contract.lock.json](contract.lock.json) — every exported
  schema serialized to one committed, comparable document. Regenerate with `pnpm --filter
  @intentic/sandbox-contract lock` whenever a schema changes; the test beside it fails until you do, and the
  repo-level prepass refuses a push whose lock *lost or changed* an existing surface without a declared
  breaking change (COMPATIBILITY.md at the repo root has the whole story).

## How it fits

Depended on by `_sandbox/sandbox` (the daemon) and `_editor/web` (the browser), by `@intentic/extension-api` (so
`api.sandbox.rpc` can be typed), and by every extension that talks to any of them. Its few shared dependencies
include `@intentic/extension-manifest`, for the install shape, and `@intentic/registry`, for marketplace rows and
their source-bound admission evidence. Keeping those schemas outside `extension-api` lets every plane import
the wire without a cycle.

## Conventions & gotchas

- **Logic lives here only when both sides must agree on it.** A chore's verdict qualifies; a view's layout does
  not. When in doubt, the test is whether disagreement between daemon and browser would be a bug.
- A cross-package type change may not resolve until the workspace settles — `@intentic/*` imports go through
  `node_modules` to the main checkout's source. See the workspace README before concluding an export is missing.
