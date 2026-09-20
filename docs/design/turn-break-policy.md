# One question per ending: what happens after a turn stops

Written 2026-09-20, from a user complaint and the source as it stood. The complaint, with a screenshot: a chat
showed two stacked cards above the composer. The first read *Limit reached · nothing ran · back at niedz.,
08:20*, and offered **Send when back** and **Continue**. The second, directly under it, read *Auto-continue is
on, continuing in about 244 min*, and offered **Turn off**. Two cards, two clocks, two off switches, one
event — and the first was offering to arm an automation that the second had already armed, for the same
instant, in different words and a different unit.

The answer, stated once here and argued below: **a turn stops for exactly one reason, and that reason gets
exactly one question with one mutually exclusive answer.** Everything else — which ladder, whose clock, which
scope — is implementation, and none of it belongs on the reader's screen twice.

## 1. What was there

Nine switches could send a turn again, over four surfaces, in seven vocabularies.

| Automation | Owned by | Armed from | Turned off from |
| --- | --- | --- | --- |
| `autoContinue`, a 3-rung ladder | **one browser tab** | a strip button, or a caret row | the second strip's *Turn off* |
| `resumeAfterLimit` | daemon (conversation override + sandbox default) | *Send it when it's back* | the strip's *Stop*, the card menu, Settings |
| `moveAfterLimit` | daemon (same) | the card menu, Settings | the card menu, Settings |
| `resumeAfterOutage` | daemon (same) | *Keep this chat going* | the strip's *Stop*, **a transcript row's link**, the card menu, Settings |
| `autoResumeOnRestart` | daemon (sandbox-wide) | Settings | Settings |
| credential re-mint | daemon, unconditional | — | — |

Six distinct defects followed from that shape, and every one of them is visible in the screenshot or one press
away from it.

- **Two cards could stack.** `ChatContinueStrip.vue` drew the pick-up row and the auto-continue row as
  independent blocks, so any chat with `autoContinue` armed and a live pick-up rendered both.
- **Two clocks disagreed about one instant.** `pickUpWhen` switched to a wall-clock time past ninety minutes
  ("back at Sun 08:20"); `formatWait` had no unit above the minute, so the same instant read "about 244 min"
  one line lower. Nobody lines those up.
- **Independent booleans modelled one decision.** `resumeAfterLimit × moveAfterLimit` spelled four postures,
  one of which ("move, else hold") nobody would deliberately choose; `autoContinue` was a fifth answer to the
  same question, held in a different place entirely.
- **Scope was invisible.** `autoContinue` died with the tab. Its neighbours survived a daemon restart. Both
  read as "this chat will carry on".
- **Arming wrote prose into the transcript.** Six notices in `turnFailures.ts` and two in `conversation.ts`,
  for what is a toggle's own state. A row saying "this chat sends the turn again by itself" is not evidence;
  it is a stale copy of a switch the reader can no longer see.
- **No press led.** Status, wait-action and Continue were all `:text="true"`, at the same weight.

## 2. The model

One ending, one question, one answer. The chat asks it about the wall in front of the reader; Settings holds
the standing answer per wall; a conversation may override either. `_shared/sandbox-contract/src/schemas/turn-break.ts`
holds the vocabulary, and everything downstream reads it.

| Ending | Answers |
| --- | --- |
| `limit` — a spent usage allowance | `wait` · `resend` (at the published reset) · `move` (another account with room) |
| `outage` — the provider's own failure | `wait` · `retry` (the shared per-provider breaker) |
| `stopped` — a hung runtime, a crashed harness | `wait` · `retry` (three rungs, then it stands down) |

`move` implies `resend`: an account with room is tried the moment the refusal lands, and the reset appointment
stands as its fallback. "Move, else hold" is gone — a reader willing to spend a second account is willing to
wait for their first. A restart is handled apart (`autoResumeOnRestart`) and stays a switch: it is the one
ending with nobody watching, so it asks no question in chat.

Everything defaults to `wait`. A re-run spends the reader's own allowance on a turn they sent once, and only
they can say whether it was worth paying for twice.

## 3. What was built

**The card** (`ChatContinueStrip.vue`). Three lines in the order a reader needs them: what happened, what will
happen and when, and the one solid press that skips the waiting. The answers are a `SegmentedControl`, so
exactly one is selected at all times and no state of this card can promise two automations. The caret beside
`Continue` holds press *variants* only — the other account, carried or fresh — never an automation, because a
second place to arm the same thing is how the surfaces drifted apart in the first place.

**One clock** (`pickUpWhen`, `formatWait`). `formatWait` carries units up through hours and days; `pickUpWhen`
is the single helper every surface renders an instant through, near as a countdown and far as a clock time
*with* its wait. "About 244 min" cannot be said any more.

**The daemon owns every ladder** (`turn-resume.ts`). `runLimitPass` became `runHeldPass`, routing by the hold's
reason: a limit keeps its one appointment at the published reset, a stopped turn climbs `RETRY_LADDER_MS`
(5s/15s/45s) and then stands down through `abandonResume` with a sentence naming the count it spent. The
try count lives in `stopTries`, apart from the pending entry, because every turn start wipes that entry —
including the ladder's own fire — so a count held there would reset itself on the very fire it bounds. Only a
turn that settles with nothing held clears it (`clearStopLadder`, called from `recordTurnHold`'s fall-through),
which is the one honest proof the run is getting somewhere.

**One reader, one writer.** `breakPolicyFor(services, conversationId, ending)` replaced three near-identical
`*Armed` functions; `agents.breakPolicy` replaced three near-identical routes; `setBreakPolicy` replaced three
near-identical client actions; `effectivePolicy` in `chat/run/turnBreak.ts` replaced three near-identical
two-level folds. The words for each answer live beside that fold, so the card, the board menu and the settings
rows cannot describe one conversation differently.

**The transcript stopped arguing with the card.** The `outageOptOut` notice action is gone, along with the
"This chat sends it again once the allowance comes back" clause on a rate-limit row. A row states what
happened; the card states what happens next and is the only thing that can change it.

## 4. What it costs

A behaviour change worth stating plainly: **auto-continue now spends allowance with no tab open.** That is the
point of moving it to the daemon, and it keeps the stance that surrounds it — off by default, explicitly
armed, capped at three rungs, and loud when it gives up. A second: the four-posture composition of
`resumeAfterLimit × moveAfterLimit` is now three, and a sandbox that had set `moveAfterLimit` without
`resumeAfterLimit` gets the reset appointment it almost certainly wanted.

## 5. Options that lose

- **Keeping auto-continue as a distinct feature, just never rendered beside a daemon automation.** Fixes the
  screenshot and nothing under it: two names for one idea, two scopes, two off switches, and the next surface
  to be written picks one of them at random.
- **A daemon-side posture for every ending including restart.** A restart has no reader to ask, so a question
  in chat about it would be asked of nobody.
- **Leaving the two limit booleans and hiding the fourth posture in the UI.** The impossible state stays
  reachable through the API and the settings file, so the surfaces would still have to guess at it.
- **Making the strip's answer a sandbox-wide write.** A late-night click inside one conversation would arm
  every agent on the board. The override is per conversation, and writing the sandbox's own value clears it
  rather than freezing a copy of a default the conversation would then quietly stop following.

## 6. How to tell it worked

Two readings over the following fortnight. Rate-limit-ended turns that needed a human press, which should keep
falling as before. And the count of chats showing more than one countdown at once, which is now zero by
construction: `chatContinue.test.ts` pins one card, one selected answer, and exactly one rendering of any
instant.
