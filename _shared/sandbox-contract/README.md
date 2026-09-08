# @intentic/sandbox-contract

The wire between the sandbox daemon and its browser client: change it here, and both sides follow.

Every route the daemon serves, every event it pushes, and every shape either side sends is declared once in this
package as an oRPC contract plus Zod schemas. The daemon implements the contract; the web app consumes it; a
mismatch is a type error rather than a runtime surprise.

## Responsibilities

- Declare the contracts, one file per subject area (`src/contracts/`).
- Declare the wire shapes those contracts are built from, one module per subject area (`src/schemas/`).
- Declare the event union the daemon pushes over SSE (`src/events.ts`), and the transcript a turn becomes: the
  rows, the patches that change them and the facts about a turn that `/agent/attach` carries.
- Hold the small pieces of logic that BOTH sides must agree on rather than each deciding: the chore book,
  hostname and tunnel-id rules, session naming, terminal protocol, workspace state, runtime state, and the two
  things every surface that waits on a daemon-run command needs (`src/command-run.ts`): the loop that follows a
  `CommandRun` to its verdict, and the words over a settled one, so the card in the app and the notification on
  a phone say the same thing about the same push.
- Define workflow designs and immutable run snapshots, including full model/account/harness pins, per-step spend
  ceilings, pinned repository bases, bounded report previews, and complete-report artifact paths.
- Hold the embeds' half of the public doors (the daemon's `automations/public-door.ts`): `src/embed.ts`, its
  own entry point and import-free on purpose, is what the Front Desk widget and the bug reporter both do before
  they do anything of their own — the door's three calls, the proof-of-work solver, the localStorage id, the
  script-tag boot.
- Hold the far end of the peer doors (the daemon's `peers/`): the hello each peer sends (`host-protocol.ts`,
  `webext-protocol.ts`, `runner-protocol.ts`), the one outbound socket loop every peer runs
  (`src/peer-dial.ts`, its own entry point) and the MCP tool server a device or a browser answers over it
  (`src/peer-mcp-server.ts`, its own entry point). Runtime-neutral by construction, since one of those peers is
  an MV3 service worker.

## Key files

- [src/contracts](src/contracts): one contract per area. Start with `agent.contract.ts` and `git.contract.ts`.
- [src/schemas](src/schemas): the wire shapes, one module per subject area, named to match the contract that
  spends them (`schemas/git.ts` under `contracts/git.contract.ts`). A contract imports the two or three modules
  it actually needs, so what a subject area is built from is visible in its import block rather than implied by
  proximity in a shared file. `schemas/internal.ts` is the exception and is not re-exported from the index: it
  holds the id and ref primitives several modules are written in, which are vocabulary rather than shapes either
  side of the wire sends.
- [src/events/](src/events): what the daemon pushes, and when, one file per family — the cards a turn raises
  ([cards.ts](src/events/cards.ts)), the transcript wire ([transcript.ts](src/events/transcript.ts): a
  `TranscriptRow` (a speaker's bubble, a notice, a card), a `TranscriptPatch` (append, replace, drop, more text or
  thinking, a tool's progress)), the turn's own frames ([agent-events.ts](src/events/agent-events.ts): the
  `AgentEvent` union, the `TurnFact` view of it, and the `AttachFrame` union a window follows a run through), the
  resume notes ([resume.ts](src/events/resume.ts)) and what is about the sandbox rather than a turn
  ([system-events.ts](src/events/system-events.ts): heartbeat, boot, presence, what just moved).
- [src/transcript-fold.ts](src/text/transcript-fold.ts), its own entry point (`@intentic/sandbox-contract/transcript-fold`):
  THE fold from a turn's frames to its rows, and the patches each frame is worth. The daemon runs it inside every
  run, the demo runs it over its recording, and the browser only applies the patches it emits, so there is one
  opinion about what a turn looks like. Its notices (a stop, a refusal, a landing, a routed tier) are written
  here too. [src/card-status.ts](src/policy/card-status.ts) is how a card settles: raised `pending`, and given its
  status by the reply that released it or by the stop that cancelled it. One card is settled by a reply the
  daemon may REFUSE: a `credential_offer` is addressed to the named people the owner's gate lists rather than
  to whoever holds a session, so a reply that reaches this derivation at all is one the daemon already accepted
  from an approver, and who that was rides on the `credential_receipt` frame (the reply carries no sender).
- [src/state/fix-stance.ts](src/state/fix-stance.ts) and [src/state/fix-attempt-plan.ts](src/state/fix-attempt-plan.ts):
  what became of the agent a surface sent after a failure (working, needs you, fix ready, landed, waiting, ended),
  and what a press on that surface does about it (open attempt 1, continue the ended attempt, start over, or wait
  for the one in play). Read here rather than in any one surface, so the editor's push question, the pipelines
  board and the daemon's `/ci/fix` route describe one agent one way and never race a second one beside it. The
  attempt ids are [src/ids/conversation-ids.ts](src/ids/conversation-ids.ts): the failure's derived id for
  attempt 1, then `-attempt2` on, so every attempt keeps its own transcript, cost and URL.
- [src/workspace-state.ts](src/state/workspace-state.ts) and [src/runtime-state.ts](src/state/runtime-state.ts): which
  changed file, and which moved runtime thing, makes which browser view stale. The workspace table also assigns
  each daemon-owned path its export lifecycle (`carry`, `secret`, `identity`, or `derived`), including the
  auth/session/cache/artifact roots, and marks the configuration slice the root repo TRACKS (`versioned`: the
  allowlist the git exclude rules are derived from, so a store added later is untracked until someone says
  otherwise) and the authored-content slice a workspace SEARCH may surface (`versioned` + `authored` →
  `SEARCHABLE_STATE_PATHS`, which iq's floor denies the rest of `.intentic` against by default). The same flag
  decides what an isolated turn shares LIVE with the main tree (`SHARED_STATE_PATHS`: every untracked group, bound
  in over the worktree) and what is the worktree's own checkout that reaches the main tree by landing (the
  tracked `config/` slice). Extensions name
  their scratch home through `extensionRuntimeDir` rather than spelling the layout themselves. The daemon
  publishes the cause and the browser derives the consequence, so neither side keeps its own copy of the
  other's list.
- [src/documents.ts](src/text/documents.ts): which of a turn's writes is a DOCUMENT, a markdown file written whole,
  as opposed to a change made to code. Shared because both sides act on the same answer: the daemon attaches
  that document to the question or plan card the turn parks on (so a choice can be read beside the write-up it
  is about), and the browser draws the write's own card as prose rather than as a diff stat. Two copies of the
  rule would let a card carry a document the transcript never drew.
- The provider vocabulary, three modules, bottom-up, and the arrow between them only points one way:
  - [src/agent-runtimes.ts](src/models/agent-runtimes.ts): what each agentic LOOP can do, one record per runtime: its
    permission axis, its MCP reach, whether it steers, and how much of the owner's system prompt it will take
    (`instructions`: replace, add, or nothing at all), plus whether it discovers loaded skills natively or
    needs their catalogue in its opening prompt. It names no providers at all.
  - [src/provider-specs.ts](src/models/provider-specs.ts): **one row per provider**, and the source every other list
    of providers in this repo derives from — the wire vocabulary (`NATIVE_PROVIDERS`), the picker's labels, the
    access and vendor tables, the plan-limit list, the routed-provider enum and its accounts schema, the
    daemon's CLIProxyAPI id map, and the web's account tabs and readiness rules. A row carries the two axes it
    deliberately keeps apart: what a turn COSTS (`access`) and what the user CONNECTS (`auth`: an OAuth account
    this daemon stores, a subscription the bundled translator holds, or a sign-in that MINTS the vendor's own
    API key, which then carries its estates' base URLs — Z.ai sells one plan through two of them and a key
    minted on one is refused by the other's host).
    `brand` is typed against the marks in `@intentic/constants`, so a provider added without a logo does not
    compile. **Adding a provider is a row here**, its brand path, and (daemon-side) one line in the provider
    registry; `provider-specs.test.ts` walks the table rather than a list, so the guard covers a provider the
    day it is added.
  - [src/contracts/accounts.contract.ts](src/contracts/accounts.contract.ts): the accounts the sandbox holds
    itself, one route family with the provider as a parameter (`/accounts/{provider}`), the lesson the
    catalog route learned applied to sign-ins: start, complete, cancel, list, rename, disconnect are the same
    six verbs for every provider, and `LoginStart` (schemas/provider-oauth.ts) is the one sign-in shape,
    whose `flow` says how an attempt ENDS (device, redirect, paste). Nothing redeemable is on any answer.
  - [src/agent-catalog.ts](src/models/agent-catalog.ts): the shapes each surface reads that table in, plus the rules
    that are about something other than a provider (the trial, the endpoint namespace, the effort and fast-mode
    gates). Shared because both sides act on it: the daemon composes a turn's instructions and skill discovery
    against it and the browser both discloses what a pair cannot do (`limitationsOf`) and names which models
    the system-prompt setting reaches.
- [src/chores](src/chores), the chore book: definitions, applicability gates and verdicts, shared because the
  daemon computes the signals and the browser renders the judgement.
- [src/approvals-execution.ts](src/policy/approvals-execution.ts): how an approved item gets done, the hold every
  approval starts with, which platforms the daemon posts to by code, and the prompts the executing turns are
  handed, shared because the daemon acts on them and the Approvals page counts the same seconds down.
- [src/workflow-faults.ts](src/text/workflow-faults.ts) and [src/output-fields.ts](src/policy/output-fields.ts): graph and
  structured-output invariants shared by the designer and daemon, including duplicate field-name rejection.
- [src/definition.ts](src/state/definition.ts): the SANDBOX DEFINITION, the declarable shape of a sandbox
  (`sandbox.toml`): repositories by remote, connections by shape, secret names, the overlay as source, the
  non-default agent settings — plus the bundle manifest that embeds it, since a bundle is definition + state.
  Shared because the daemon derives definitions and the browser renders them and their diffs; the definition
  never carries a credential value or an approval hash, so it is the export that is safe to publish. Only the
  OUTBOUND half lives here; applying one is an arrival.
- [src/arrival.ts](src/state/arrival.ts): the ARRIVAL PIPELINE, one plan → apply → report for every artifact that can
  come into a sandbox — a definition, an environment bundle, a Hermes or OpenClaw home directory. There were
  three of these once, one per artifact, and the differences between them were drift rather than design (only
  two of the three previewed; the credential consent was asked on opposite sides). The artifact is a parser
  now and everything after it is shared, which is what lets one card render all four.
- [src/index.ts](src/index.ts): the public surface.
- [src/contract-lock.ts](src/state/contract-lock.ts) and [contract.lock.json](contract.lock.json): every exported
  schema serialized to one committed, comparable document. Regenerate with `pnpm --filter
  @intentic/sandbox-contract lock` whenever a schema changes; the test beside it fails until you do, and the
  repo-level `contract-shrink` check refuses a push whose lock *lost or changed* an existing surface without a declared
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
