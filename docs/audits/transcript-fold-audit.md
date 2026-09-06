# Architecture audit: one transcript, folded once

A whole-repository pass (688k lines of TypeScript and Vue across 98 packages: the sandbox daemon, the editor, the
platform, the machine agent, the extensions and the deployment engine) looking for the single architectural change
that buys the most maintainability, performance and post-launch safety, weighted toward changes that delete code.

The finding: **a conversation is folded from raw agent frames in three places, and the wire carries the frames
instead of the fold.** Move the fold into the daemon, once, and put transcript rows on the wire. Everything below is
the evidence, the design, and the alternatives that were weighed and ranked lower.

---

## 1. What is duplicated

An agent turn produces a stream of `AgentEvent` frames (`sandbox-contract/src/events.ts`): about forty kinds, from
token-level `delta`s to `tool_call`, `plan`, `question`, `service_offer`, `tier`, `steer`, `preamble`. Those frames
are turned into the rows a chat displays by three separate pieces of code:

| Where                                                                                   | Input                              | Output            | Frame kinds handled | Lines |
| --------------------------------------------------------------------------------------- | ---------------------------------- | ----------------- | ------------------- | ----- |
| Browser, live: `_editor/web/src/composables/chat/turnReducer.ts`                        | `AgentEvent` (via `/agent/attach`) | `ChatMessage`     | 43                  | 905   |
| Daemon, at settle: `_sandbox/sandbox/src/sessions/turn-transcript.ts` (`foldFrames`)    | `AgentEvent` (the run's frame log) | `RestoredMessage` | 12                  | 614   |
| Browser, on reopen: `conversation.ts` `restoreMessages` + `turnReducer.ts` `restoredCards` | `RestoredMessage`                  | `ChatMessage`     | —                   | ~150  |
| Daemon, for the fleet board: `_sandbox/sandbox/src/agents/agents-registry.ts`           | `AgentEvent`                       | status/activity   | 17                  | (part of 1,583) |

`RestoredMessage` (`events.ts` L513–630) and `ChatMessage` (`transcript.ts` L241–365) are the same row spelled twice;
the browser already concedes it with `CARD_KINDS = RESTORED_CARD_FIELDS`. Each `ChatMessage` field carries a
live-path story and a reopen-path story in its comment (`sentAt`, `recorded`, `rewindIndex`, `run`, `checkpointId`),
and the daemon's fold is annotated throughout with the browser rule it is imitating: "Mirrors the client's own row
guard (recordedRows)", "the live client's own move (turnReducer: withBubble, then bubbleId null)", "the client's own
guard (turnReducer's `hasProse`)". That is a parity chase written into the source.

Two more producers exist because frames are the wire: the marketing demo fakes the whole frame protocol
(`_site/demo/src/turn.ts`, 39 frame literals, plus `sse.ts` and `fixture/transcripts.ts`: 711 lines), and every
adapter test fixture speaks it.

## 2. What it has cost

Measured from git, 2026-03-01 to today:

- 143 commits touched one side of the fold (the four browser chat files, the daemon's `sessions/` cluster, or
  `events.ts`); **37 of them had to touch both sides** in the same commit.
- The parity bugs have names: `fix(sessions): render resumed turns without duplicating prompts`, `feat: persist
  interactive cards in restored transcripts` (a reopened chat "showed the prose before a question and the prose
  after the answer, and nothing of the question"), `fix: sync attachmentPreviews, transcript replay, and agent
  endings`, `fix: codex agents broken transcript loading`, `fix(agent): preserve TurnNote disclosures across prompts
  and transcripts`, `refactor(chat): unify the conversation's card, error and turn-lifecycle paths`.
- `useChat.ts` and `conversation.ts` are the 6th and 7th most-changed source files in the repository since June (61
  commits each); `events.ts` is 9th (58). Together with `turnReducer.ts` and `transcript.ts` they account for 106
  commits.
- The chat composables are 15,460 non-test lines; the eight files that exist to fold, replay, cache and reconcile
  frames (`turnReducer`, `transcript`, `transcriptCache`, `turnStream`, `agentTranscript`, `turnFailures`,
  `transcriptClock`, `tabSnapshot`) are 3,417 of them, with 4,652 lines of tests (`conversation.test.ts` alone is
  3,957 lines, most of it driving frames through the reducer).

## 3. Why this is the most impactful change

**Maintainability.** A new frame kind today costs six edits: the schema, the daemon fold, the browser fold, the
restored mapping, the registry's status switch, and the demo fake. The kinds keep arriving (`service_offer`,
`payment_offer`, `capability_offer`, `tier`, `preamble`, `steer` are all recent). After the change it costs two:
the row schema and the daemon fold. The renderer reads rows.

**Failure surface after going public.** The browser is served by the platform and is, by design, routinely newer
than a user's daemon (`sandbox-contract/src/routes.ts` explains why and builds a route-advertisement mechanism for
it). With frames on the wire, the *interpretation* of a conversation is split across two builds: a settled turn
was folded by the daemon's fold version N and written to the record; the same conversation's live turn is folded
by the browser's fold version N+1. The user sees one arrangement while watching and another after a reload, and
no mechanism can catch it: the route-shape fingerprint covers `AttachFrameSchema` as a shape, and a changed fold
*rule* is not a schema change. With rows on the wire, there is one interpreter, and the wire is a data shape the
existing `contract.lock.json` already governs. The `AgentEvent` union stops being public surface at all.

**Performance.** `/agent/attach` replays a run from its first frame on every attach (`turn-runs.ts` `follow`,
`conversation.ts` `reattach` → `dropRun`); frames are per-token (`sdk-stream.ts:436` yields one `delta` per SDK
text delta), so a long turn is thousands of frames, each validated against a forty-member discriminated union by
the oRPC event iterator on the daemon's single event loop, per attached client, and then re-folded in the
browser. `turn-runs.ts` records the consequence: retention was cut from five minutes to one because "several
multi-megabyte raw frame logs" let the daemon "climb toward a gigabyte". Rows are O(bubbles + tool cards); a
reattach becomes "the rows so far, then patches", and a reopen paints the record with no fold at all.

**It also deletes a class of machinery that only exists because of the split:**

- the IndexedDB transcript mirror's build-epoch drop (`transcriptCache.ts` `dropTranscriptStore`), needed because
  `ChatMessage` is a browser-private shape that can change per build; when the cached thing is the wire row, the
  lock governs it;
- `reuseUserBubble`, `dropRun`, `recordedRows`, `withCancelledCards`, `restoredAttachmentFields`, the
  `RESUME_NOTES` prefix-recognition on the client, and the `recorded` flag that tells "a row the daemon wrote"
  from "a row this window drew";
- the provider-session-store backfill (`sessions/session-store.ts`, `codex-sessions.ts`, `interruptedTurnRows`:
  ~420 lines), once the fold runs live and the run's rows are what the journal checkpoints.

The rest of the product is already row-shaped: `Subagents.vue` renders `RestoredMessage[]` directly, the share
view (`_editor/share-view`) and `share-payload.ts` work on `RestoredMessage`, the workflows and automation views
read transcripts, not frames. The chat pane is the one viewer that insists on frames, and it is the one with the
bugs.

## 4. The design

One row type, one fold, patches on the wire.

**Contract.** `RestoredMessageSchema` becomes `TranscriptRowSchema` (it already carries the cards with their
`reply`; the statuses the browser derives from `reply` are derivable on either side and can ride as a field).
`AttachFrameSchema` becomes:

```
attached { run, startedAt, rows: TranscriptRow[], seq }   // the rows so far, the whole state at attach time
patch    { seq, op }                                       // append(row) | replace(index, row) | text(index, delta) | card(index, patch)
end      {}
```

`text(index, delta)` keeps prose streaming token by token, so the typewriter (`TranscriptClock`) keeps its seam;
it just reveals a row's pending text instead of a reducer's `pending` buffer. `AgentEventSchema` stays as the
adapters' output vocabulary but leaves `index.ts` and the lock: it is daemon-internal.

**Daemon.** `foldFrames` moves into `TurnRun` as an incremental fold: `push(frame)` becomes `fold.apply(frame)`
producing zero or one patch; `follow(after)` yields patches after a cursor; the head frame carries `fold.rows`.
`recordTurnTranscript` stops being a second fold and becomes "append `run.rows` to the record", so the record and
what every window saw are the same bytes. The registry's 17-case frame switch reads the fold's state instead
(open card ⇒ awaiting, last tool card ⇒ activity). The daemon's existing 1,781 lines of session tests carry over
to the incremental fold unchanged in what they assert.

**Browser.** `turnReducer.apply` becomes `applyPatch` (a switch over four ops, under 150 lines).
`restoreMessages` becomes `rows = record` with no mapping; `restoredCards` goes; `reattach` takes the head's rows
and drops nothing. `ChatMessage` becomes `TranscriptRow & { id: number; pending?: string }`: the wire row plus
what is genuinely presentational. Of the 15 `TurnEffect` kinds the reducer raises today (`session`, `worktree`,
`liveMode`, `commands`, `usage`, …), most are facts the daemon already stores on the registry entry and can put
on the head or a run-status patch; the two that are local (a typewriter flush, a local error line) stay.

**Demo, share, subagents.** Already row-shaped; the demo's `turn.ts` becomes a short row script.

## 5. What goes away

Estimated, non-test / test:

- Browser: `turnReducer.ts` 905 → ~150; `transcript.ts` mapping and reconciliation helpers ~250 of 648;
  `conversation.ts` restore/reattach/effect paths ~700–900 of 2,550; `transcriptCache` epoch logic; `turnStream`
  replay boundary. **≈ 2,000–2,500 lines, plus ≈ 3,000 lines of tests** that exist to drive frames through the
  browser fold.
- Contract: the `RestoredMessage`/`ChatMessage` duality, `RESTORED_CARD_FIELDS`, `RestoredCards`, two `holdsCard`s;
  ~40 frame shapes leave the public lock.
- Daemon: `restoredTurn`/`recordTurnTranscript` as a separate fold; the registry's frame switch; the provider
  store backfill readers (~420 lines) under the repo's own no-migration rule.
- Demo: `turn.ts` 363 → ~100.

Net: on the order of **5–7k lines removed** (tests included), concentrated in the two files that change most
often in the repository. Nothing new is added beyond a patch schema and an incremental version of a fold that
already exists.

## 6. Migration (a clean break, per CLAUDE.md)

1. Contract: promote `RestoredMessageSchema` to `TranscriptRowSchema`, add `TranscriptPatchSchema`, rewrite
   `AttachFrameSchema`, remove `AgentEventSchema` from the public index. Regenerate the lock; the shrink is
   declared with a `feat!:` subject and a `Breaking-Note:` (COMPATIBILITY.md).
2. Daemon: make `foldFrames` incremental inside `TurnRun`; `follow` yields patches; `recordTurnTranscript` appends
   `run.rows`; the registry reads fold state; the journal checkpoints rows on each closed bubble so an interrupted
   turn recovers from the daemon's own rows rather than from a provider's store. Delete the provider readers.
3. Browser: `applyPatch` replaces the reducer; delete `restoreMessages`' mapping, `restoredCards`, `dropRun`,
   `reuseUserBubble`, `recordedRows`; `transcriptCache` stores rows verbatim; `TranscriptClock` reveals row
   pending text.
4. Demo emitter, share payload and subagent transcript adopt the row type by rename.
5. Version skew during rollout: the route-shape fingerprint on `agent.attach` changes, so a newer browser against
   an older daemon reads as the existing "update available" gate rather than as a broken chat.

## 7. Risks

- **Typing feel.** Text must stream as `text(index, delta)` patches, never as whole-row replacements, or the chat
  loses the typewriter. `TranscriptClock` is the seam that already separates arrival from reveal.
- **Nested subagent cards.** The daemon fold already nests children under the spawning card by id; `card(index,
  patch)` must address nested cards by tool id the way `tool_call_update` does now.
- **Rewind and fork arithmetic.** Both count record rows (`rewindIndex`, `recordedRows`, `forkCutsOf`). With rows
  as the only currency the two numberings collapse into one, which removes the bug class but means the cut logic is
  rewritten rather than kept.
- **Fleet board status.** Reading status off fold state instead of frames changes when `awaiting` flips (on the
  card's row appearing rather than on the frame). Same moment in practice; worth a test.

---

## Alternatives weighed

Ranked below the finding above because each is either smaller, adds code, or is a mechanical migration the codebase
has already begun.

**Two doors into the daemon.** The contract declares 290 oRPC procedures with a typed client (`sandboxRpc`), and
that client is used at **2** call sites in the editor; `sandboxRequest`/`sandboxJson` path-string calls are used at
**168**. About 80 further endpoints are registered by hand in `app.ts` outside the contract and its lock. Worth
finishing (`sandboxRpc.ts`'s header already says this is the direction), and it would let the route-advertisement
skew mechanism cover every call, but it is a per-site migration, not a structural change, and it deletes little.

**The demo daemon.** `_site/demo` re-implements the daemon's surface in the browser (6.5k lines). Its hardest part
is faking the frame stream; the change above shrinks that to a row script. The rest is fixtures the site needs.

**One process does everything.** The daemon carries roughly 9k lines of self-protection for a single event loop
(`memory-admission`, `memory-gate`, `loop-watchdog`, `heavy-commands`, `workload-priority`, `reaper`). Moving git
scans, screencast and speech out of the process is a real failure-surface win after launch, but it adds code and
a supervision layer; the extension backend host already shows the pattern to copy when it is time.

**Serve the SPA from the daemon** to remove browser/daemon skew altogether. Conflicts with the multi-sandbox fleet
view (`fleetAcross.ts`) and the pre-sandbox setup flow, both of which need one app across many daemons.

## Outcome

Implemented. One fold lives in the contract (`@intentic/sandbox-contract/transcript-fold`), the daemon runs it
inside every `TurnRun`, `/agent/attach` carries rows, patches and facts, the browser applies patches, and the
demo, the ACP bridge and the subagent transcripts read rows. `turnReducer.ts`, `foldFrames`, `restoredCards`,
`reuseUserBubble`, `dropRun` and the provider-store backfill readers are gone.
