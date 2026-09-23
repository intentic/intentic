# Turns that never ran

What the transcript does with a turn the daemon refused before the model saw it, and why such a turn leaves no
trace at all.

Read this before touching `turnedAwayCode` (`policy/turned-away.ts`), `TranscriptFold.retract`, or the settle in
`startTurnRun`.

## The bug this answers

A send under memory pressure produced this, three presses in a row:

```
user      Running tests is one of the performance bottlenecks…
notice    Not enough sandbox memory to start this turn (10.5 GiB resident + 7.1 GiB swapped, against 16.0 GiB).
          … Your message was not delivered: it is held for you to send again.
user      Running tests is one of the performance bottlenecks…      ← the same words
notice    Not enough sandbox memory to start this turn (11.0 GiB resident + 7.0 GiB swapped, against 16.0 GiB).
user      Running tests is one of the performance bottlenecks…      ← and again
notice    Not enough sandbox memory to start this turn (11.6 GiB resident + 5.2 GiB swapped, against 16.0 GiB).
user      Running tests is one of the performance bottlenecks…      ← the press that finally ran
```

It read as a rendering fault. It was not: all eight rows were in `/history/transcripts/<id>.jsonl`. Seven
records on the machine this was found on held 24 such rows between them.

Memory no longer refuses the second press: a person is held once and the next send runs
(`low-memory-hold.md`). That one hold is still a refusal that ran nothing, and every other code
`turnedAwayCode` names can still repeat the way this one did.

**The mechanism.** A refusal is a value returned by `planTurn` and yielded as an `error` frame
(`agent.routes.ts` `refusalFrame`). By then the run already exists: `startTurnRun` opened its fold on the
user's message, and the frame folds in under it as a notice. The settle then appended `run.rows` — message
*and* refusal — to the record. Meanwhile the refusal's own sentence promises the message is "held for you to
send again", and the composer really does hold it. So the words exist twice after one press, and the next
press writes the pair again. The count is `presses`, not `presses − 1`, because every one of them is recorded.

The client did try to compensate: `takeBackUserBubble` spliced the bubble out of the live transcript. That is
why it looked like a rendering bug — the live window was briefly right and everything else was wrong. The
daemon's rows are the authority, so the next attach, reload or record read brought the message back, and the
splice also renumbered rows the daemon addresses by index.

## The rule

**A turn refused before it ran did not happen** — when its sender still holds the words. Nothing about it is
recorded: not the message, not the refusal, not the rebase notice it collected on the way. The one sender that
holds them is the composer behind `POST /agent`; every turn the sandbox starts itself is the other case, below.

The refusal is still drawn, live, on the run that produced it — otherwise a press that changes nothing looks
like a press that did nothing. It lives as long as the run does (`RETAIN_MS`) and is gone on reopen.

Three consequences follow, and they are the whole implementation:

1. `TranscriptFold.retract` drops the opening user row when a held-for-resend refusal folds in, as an ordinary
   `drop` patch. Every attached window loses the bubble by the same mechanism as everything else, and a
   re-attach cannot bring it back, because the head's rows no longer contain it.
2. `TranscriptFold.ranNothing` reports it, and `startTurnRun`'s settle skips the record write.
3. The client stops splicing rows it does not own. `requeueUndelivered` takes the words from the send that
   holds them (`TurnContext.sent`) rather than reading them back out of the transcript.

## Which refusals count

`turnedAwayCode` in `policy/turned-away.ts` is the list, and its meaning is exactly **nothing ran, so the
message is still owed to somebody**. A code missing from it gets a notice that does not promise a resend and a
bubble that stands — which is the bug above, wearing a different code. `model-unavailable` and
`engine-version-floor` were missing and are now on it.

Two boundaries this list must keep:

- **Attended only.** A run that started itself — an automation, a loop, a watch wake — has no composer, so
  nothing is held and nothing can repeat. Its refusal is the only evidence it was skipped, so it is recorded.
  `errorRow` already says a different sentence for it; `retract` declines for the same reason.
- **Refused, not interrupted.** A refusal arriving after the agent has spoken ends a turn that happened.
  `ranNothing` re-derives from the rows rather than latching a flag, so anything said keeps its record.

A refusal that spent tokens is not on this list and must not be: `provider-outage` and `rate_limit` reach the
provider, and `errorRow` answers both before the list is consulted.

## Turns the sandbox started itself

Pipelines' **Fix with agent** (`POST /ci/fix`), a peer's `agents message`, a verify nudge and every re-run of a
held or interrupted turn start through `startConversationTurn` with no composer behind them. The rule above,
applied to them, lost the only copy: a fix press turned away for memory opened a conversation with no prompt in
it, a notice claiming "Your message is held", and no **Send anyway**, since the chat offers that press only while
its own queue holds something. The next thing typed became the agent's whole brief.

So the keeper is decided where the turn starts. `POST /agent` passes `senderKeeps`; every other start leaves the
sandbox as the keeper, and `startTurnRun`'s `holdTurnedAway` does three things with a refusal `turnedAway`
recognises, before it is folded:

1. The frame goes out with `held: { ran: false }`, so `retract` leaves the message where it was and the run is
   recorded like any other: the prompt survives a reload and a restart.
2. `heldRow` says the message above is kept here, marks the row `sandboxHeld`, and offers **Send anyway** (memory)
   or **Send again** (any other code). The press is the turn client's `resendKept`: `POST /agent/resume` with no
   routing, so the turn runs as it was started, pinned model and all. A sandbox that no longer keeps it (a restart)
   gets the message's own words as an ordinary send instead.
3. The turn is held as a `door` hold (the conversation actor's `turn-held`). The resume pass never fires one:
   going past the wall is a person's call. The re-run carries `RESUME_NOTES.door`, opens on a notice rather than a
   second copy of the message, and names every refused run in `unseenRuns`, which a session seeded from the record
   skips.

A fix attempt turned away this way reads **Didn't start**, and its next press is a `resend` (`planFixAttempt`):
the kept turn again, or the whole prompt when nothing is kept, never the "carry on" nudge, which points at
evidence the attempt never received.

## The records already written

None are read. Records written before `retract` lived in the layout before conversation units (`/history/transcripts`,
`turn-checkpoints.json`), which the daemon no longer reads: per the repository's no-migration rule it starts from
fresh state, so a void turn exists only in files nothing opens.

## Known, not fixed

`agents.begin` runs before the admission gate, so `entry.turns` counts a refused turn. A conversation whose
first send is refused therefore believes its next turn is not its opening one, and skips the notes that ride
only there: the workspace map, the skill catalogue, the spawn note, the turn-ending note. Fixing it needs the
registry to learn "ran nothing" without re-deriving the fold's judgement, which is a seam that does not exist
yet.
