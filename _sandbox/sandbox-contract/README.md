# @intentic/sandbox-contract

The wire between the sandbox daemon and its browser client: change it here, and both sides follow.

Every route the daemon serves, every event it pushes, and every shape either side sends is declared once in this
package as an oRPC contract plus Zod schemas. The daemon implements the contract; the web app consumes it; a
mismatch is a type error rather than a runtime surprise.

## Responsibilities

- Declare the contracts, one file per subject area (`src/contracts/`).
- Declare the wire shapes those contracts are built from, one module per subject area (`src/schemas/`).
- Declare the event union the daemon pushes over SSE (`src/events.ts`).
- Hold the small pieces of logic that BOTH sides must agree on rather than each deciding: the chore book,
  hostname and tunnel-id rules, session naming, terminal protocol, workspace state, runtime state.
- Define workflow designs and immutable run snapshots, including full model/account/harness pins, per-step spend
  ceilings, pinned repository bases, bounded report previews, and complete-report artifact paths.

## Key files

- [src/contracts](src/contracts): one contract per area. Start with `agent.contract.ts` and `git.contract.ts`.
- [src/schemas](src/schemas): the wire shapes, one module per subject area, named to match the contract that
  spends them (`schemas/git.ts` under `contracts/git.contract.ts`). A contract imports the two or three modules
  it actually needs, so what a subject area is built from is visible in its import block rather than implied by
  proximity in a shared file. `schemas/internal.ts` is the exception and is not re-exported from the index: it
  holds the id and ref primitives several modules are written in, which are vocabulary rather than shapes either
  side of the wire sends.
- [src/events.ts](src/events.ts): what the daemon pushes, and when.
- [src/workspace-state.ts](src/workspace-state.ts) and [src/runtime-state.ts](src/runtime-state.ts): which
  changed file, and which moved runtime thing, makes which browser view stale. The workspace table also assigns
  each daemon-owned path its export lifecycle (`carry`, `secret`, `identity`, or `derived`), including the
  auth/session/cache/artifact roots, and marks the configuration slice the root repo TRACKS (`versioned`: the
  allowlist the git exclude rules are derived from, so a store added later is untracked until someone says
  otherwise) and the authored-content slice a workspace SEARCH may surface (`versioned` + `authored` →
  `SEARCHABLE_STATE_PATHS`, which iq's floor denies the rest of `.intentic` against by default). Extensions name
  their scratch home through `extensionRuntimeDir` rather than spelling the layout themselves. The daemon
  publishes the cause and the browser derives the consequence, so neither side keeps its own copy of the
  other's list.
- [src/documents.ts](src/documents.ts): which of a turn's writes is a DOCUMENT, a markdown file written whole,
  as opposed to a change made to code. Shared because both sides act on the same answer: the daemon attaches
  that document to the question or plan card the turn parks on (so a choice can be read beside the write-up it
  is about), and the browser draws the write's own card as prose rather than as a diff stat. Two copies of the
  rule would let a card carry a document the transcript never drew.
- [src/agent-catalog.ts](src/agent-catalog.ts): what each (provider, harness) pair can actually DO, as one
  record per runtime: its permission axis, its MCP reach, whether it steers, and how much of the owner's system
  prompt it will take (`instructions`: replace, add, or nothing at all), plus whether it discovers loaded
  skills natively or needs their catalogue in its opening prompt. Shared because both sides act on it: the
  daemon composes a turn's instructions and skill discovery against it and the browser both discloses what a
  pair cannot do (`limitationsOf`) and names which models the system-prompt setting reaches.
- [src/chores](src/chores), the chore book: definitions, applicability gates and verdicts, shared because the
  daemon computes the signals and the browser renders the judgement.
- [src/approvals-execution.ts](src/approvals-execution.ts): how an approved item gets done, the hold every
  approval starts with, which platforms the daemon posts to by code, and the prompts the executing turns are
  handed, shared because the daemon acts on them and the Approvals page counts the same seconds down.
- [src/workflow-faults.ts](src/workflow-faults.ts) and [src/output-fields.ts](src/output-fields.ts): graph and
  structured-output invariants shared by the designer and daemon, including duplicate field-name rejection.
- [src/definition.ts](src/definition.ts): the SANDBOX DEFINITION, the declarable shape of a sandbox
  (`sandbox.toml`): repositories by remote, connections by shape, secret names, the overlay as source, the
  non-default agent settings — plus the bundle manifest that embeds it, since a bundle is definition + state.
  Shared because the daemon derives definitions and the browser renders them and their diffs; the definition
  never carries a credential value or an approval hash, so it is the export that is safe to publish. Only the
  OUTBOUND half lives here; applying one is an arrival.
- [src/arrival.ts](src/arrival.ts): the ARRIVAL PIPELINE, one plan → apply → report for every artifact that can
  come into a sandbox — a definition, an environment bundle, a Hermes or OpenClaw home directory. There were
  three of these once, one per artifact, and the differences between them were drift rather than design (only
  two of the three previewed; the credential consent was asked on opposite sides). The artifact is a parser
  now and everything after it is shared, which is what lets one card render all four.
- [src/index.ts](src/index.ts): the public surface.
- [src/contract-lock.ts](src/contract-lock.ts) and [contract.lock.json](contract.lock.json): every exported
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
- A cross-package type change may not resolve until the workspace settles: `@intentic/*` imports go through
  `node_modules` to the main checkout's source. See the workspace README before concluding an export is missing.
