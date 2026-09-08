# Handing a turn off after a spent allowance: a policy, a price, and a brief that is measured

Written 2026-09-07 from the source as it stands. The question asked: the daemon's own record for the week
showed 822 turns, 182 of them failed, and nearly every failure was a wall the provider put up rather than a
fault in the work (a spent Claude window, a Kimi 5-hour cap, a revoked token, a 529). The turn is held whole
and the chat offers a press, an appointment at the reset, and "continue on the other account". What was
missing was the quality of the hand-off itself and the honesty of the offer. The answer, stated once here and
argued below: **the way on stays the owner's decision, made once as a policy or each time as a press; every
way on says what it costs in tokens; a fresh session is handed what the sandbox measured, not what the model
remembers; and a move to another account may carry the session instead of losing it.**

Two constraints from the owner shaped it. A hand-off always costs tokens, whether the context is re-read
cold or a fresh session is briefed, so the act has to be done well or not at all. And nothing passes a turn
on its own: a policy the owner set is their decision, one of the policies is "hold for my press", and every
default is off.

## 1. What the record said

The turns record (`mcp__diagnostics__turns`, seven days to 2026-09-07): 822 turns, 182 failed, 219 finished
with unproven code changes. Of the newest 200, 17 were errors: 12 `rate_limit`, 3 revoked tokens, 1 model
unavailable, 1 harness death. The transcripts since 2026-08-24 carry sixteen prompts about limits, three of
them on 2026-09-05 alone ("usage limit prevented me from running an agent to rebase", "I do not see any
button"), and one on 2026-09-07 about a session that "reported finished work, but the task list stays
unfinished", which is what a hand-off that loses the checklist looks like from the board.

## 2. What was there

`agent/run/turn/turn-resume.ts` already held a refused turn whole (`pendingLimit`), re-ran it on a press
(`fireLimitResume`, with a `routing` so the press could name another account), and fired it by itself at the
provider's reset when `resumeAfterLimit` said so, per conversation or for the sandbox. `agent.routes.ts`
dressed the failure frame with the reset instant and the hold. A turn that resumed no session was seeded from
the conversation's record by `runtime-history.ts`: a capped envelope of the transcript with tool names and
the user's decisions, no tool output.

Three things were missing.

- **The envelope carried what was said, not what was true.** Whether the edits the last turn described are on
  the branch, whether a check proved them, which checklist items were crossed off: none of it travelled. A
  model handed only words fills those gaps by recall, and recall across a hand-off is where "finished" turns
  come back with three items open.
- **The offer never said what it cost.** "Continue" could re-read a hundred thousand tokens of context, cold,
  or open a fresh session for six thousand, and the button read the same either way.
- **A move to another account always lost the session.** `movedRouting` retired it on any account change, on
  the grounds that a session belongs to the credential that minted it. It does not: the session is a file the
  daemon keeps under the workspace (`sessions/session-store.ts`), and the credential is an env the daemon
  passes per turn. What a move costs is one cold re-read of the context on the other account, the same price
  a same-account re-run at the reset pays.

## 3. What was built

### The brief (`agent/prompt/handoff-state.ts`)

Every turn seeded from the record, whatever retired the session (a spent allowance moved, a provider or
account switch, a forgotten session), gets one more preamble note beside the envelope, headed *Where the
work stands*, built from readings and nothing else:

- the branch, per repository in the conversation's composition, from `git status`: files changed, +/−,
  staged and unstaged counts, up to forty paths and then a count; a retired checkout is named, not read; on
  the main tree only the paths the turn itself edited are read, grouped by repository, because the rest of
  that tree is other people's work;
- the last turn's edited paths and its verification standing, off the proof ledger the turn kept
  (`verified by <check>`, `unproven: no check ran after the last edit`, `failing: <check>`), or the registry's
  failed-check name where no ledger survived;
- the checklist as the CLI's own task store keeps it for the retired session (`task-store.ts`), which is the
  reading the fold cannot see, with the open items to re-create and the done ones not to redo;
- a provenance line, "Measured by the sandbox at 14:32 UTC, not recalled".

Pointers, never contents. Capped at 6,000 characters, about 1,500 tokens, paths dropped first. It rides the
`preamble` frame so the envelope's parser is untouched and the chat shows it collapsed.

This follows the guidance current at the time of writing. Anthropic's *Effective context engineering for AI
agents* (fetched 2026-09-07): a compaction summary keeps architectural decisions, unresolved bugs and
implementation details and discards raw tool output; state is persisted outside the window; a sub-agent's
hand-off is a condensed summary of one to two thousand tokens; the next agent is given lightweight
identifiers (paths) and retrieves just in time. The envelope was tightened on the same principle: the newest
two exchanges keep their full cap, an older assistant message keeps its opening 1,500 characters, and the
user's words are never cut.

### The price, on the offer (`limit-way.ts`, `pickUp.ts`, `ChatContinueStrip.vue`)

At the failure, once, the daemon works out the way on and its cost: `contextTokens` as the last usage frame
measured it (what a press that keeps the session re-reads, cold, because a prompt cache is per account and
expires in minutes), and `handoffTokens`, the envelope plus the brief rendered exactly as a fresh turn would
render them, counted at four characters a token. Both ride the failure frame and the record's ending, so a
reopened tab says the same numbers. The strip puts them where they are read: on the press ("re-reads ~85k
tokens of context, cold"), on the appointment, and on the two rows the other account now gets.

### The policy (`moveAfterLimit`, `limitMoveCarryUnder`)

`SandboxSettings.moveAfterLimit` (default off, per-conversation override like its neighbours) moves a held
turn to another connected account of the same provider that still has room, as soon as the refusal lands.
Composed with `resumeAfterLimit` it spells the four postures: hold for a press, send again at the reset, move
or else hold, move or else send at the reset. `sibling-account.ts` makes the daemon's judgement the way the
chat's `limitFallback.ts` makes it: a reading with room, never the absence of one, emptiest first, a dead
credential is not room. Claude only, because Claude is the provider whose accounts the daemon picks between;
a routed provider balances its own credentials before it refuses, and a different provider is never a move.

`limitMoveCarryUnder` (default 100,000 tokens) is the owner's line between the two prices: under it a policy
move carries the session, at or above it a fresh session starts from the brief, zero never carries. The
owner chose this over "always carry" and "always fresh" when asked.

### The carry (`ResumeRouting.carry`, `RESUME_NOTES.carried`)

A press or a booked move that names another account of the same provider may keep the session. The model is
told the one fact it cannot see, that its context is about to be read cold on somebody else's allowance, and
nothing else changes. The spike that would have proved a carried session is accepted by the other
organisation could not run here (one Claude account is connected), so the carry keeps a safety net: a carried
re-run the provider refuses outright, with nothing that reads as an allowance, a credential or an outage, is
re-recorded with `carryRefused` and a fresh session with the brief follows on the next pass, once.

## 4. What it costs

One transcript read and a handful of git statuses on the failure path, once per refusal. Nothing on a turn
that does not fail. The brief adds up to ~1,500 tokens to a fresh session's opening message, in exchange for
the envelope losing a comparable amount from its older assistant messages.

## 5. Options that lose

- **Moving turns automatically as a reflex, with no policy.** Spends the owner's second account on their
  behalf; the owner ruled it out.
- **Cross-provider moves.** Retires the session for a saving that is not one (`settings.ts` says the same of
  the downgrade list); the manual switcher still allows it.
- **A brief written by a model.** Costs a call and can say what the turn wished were true; the ledgers already
  hold the truth and a model reading them adds nothing but risk.
- **Putting the brief inside the envelope.** The envelope is parsed back apart when the session store is read,
  and a section inside it would come back as somebody's message.

## 6. How to tell it worked

The turns record carries `errorCode`, `verification` and the checklist counts per turn. Two numbers to watch
over the following fortnight: rate-limit-ended turns that needed a human press, and turns ending
`unproven` with a checklist still open on the turn after a hand-off. Both should fall towards zero on a
sandbox with the policy on and a sibling account connected.
