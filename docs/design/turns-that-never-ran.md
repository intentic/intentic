# Turns that never ran

What the transcript does with a turn the daemon refused before the model saw it, and why such a turn leaves no
trace at all.

Read this before touching `HELD_FOR_RESEND`, `TranscriptFold.retract`, or the settle in `startTurnRun`.

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

**A turn refused before it ran did not happen.** Nothing about it is recorded: not the message, not the
refusal, not the rebase notice it collected on the way.

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

`HELD_FOR_RESEND` in `transcript-fold.ts` is the list, and its meaning is exactly **the composer still holds
the message**. A code missing from it gets a notice that does not promise a resend and a bubble that stands —
which is the bug above, wearing a different code. `model-unavailable` and `engine-version-floor` were missing
and are now on it.

Two boundaries this list must keep:

- **Attended only.** A run that started itself — an automation, a loop, a watch wake — has no composer, so
  nothing is held and nothing can repeat. Its refusal is the only evidence it was skipped, so it is recorded.
  `errorRow` already says a different sentence for it; `retract` declines for the same reason.
- **Refused, not interrupted.** A refusal arriving after the agent has spoken ends a turn that happened.
  `ranNothing` re-derives from the rows rather than latching a flag, so anything said keeps its record.

A refusal that spent tokens is not on this list and must not be: `provider-outage` and `rate_limit` reach the
provider, and `errorRow` answers both before the list is consulted.

## The records already written

`_tools/scripts/repair-transcripts.mjs` removes them, once, by hand. It is not wired into boot: per the
repository's no-migration rule, product code assumes fresh state.

It finds a void turn by run id — every row carries the id of the run that folded it — as a maximal adjacent
span holding a user message, holding nothing the agent said, and ending on a held-for-resend refusal. Rows
without a run id predate the stamp and are matched by adjacency instead.

It renumbers `turn-checkpoints.json` in the same pass. A rewind point is filed against a row's index, so
deleting rows without shifting the checkpoints above them puts the rewind button on the wrong message.

## Known, not fixed

`agents.begin` runs before the admission gate, so `entry.turns` counts a refused turn. A conversation whose
first send is refused therefore believes its next turn is not its opening one, and skips the notes that ride
only there: the workspace map, the skill catalogue, the spawn note, the turn-ending note. Fixing it needs the
registry to learn "ran nothing" without re-deriving the fold's judgement, which is a seam that does not exist
yet.
