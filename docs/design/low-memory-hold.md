# Low memory: warned once, then obeyed

What a turn meets on a sandbox that is short of memory, and why a person is asked once instead of refused.
The policy is `_sandbox/sandbox/src/platform/resources/memory-admission.ts`, the sentence and its press are
`heldRow` in `_shared/sandbox-contract/src/text/transcript-fold.ts`, and the presses are drawn by
`_editor/web/src/features/chat/transcript/ChatMessageView.vue`.

## What it replaced

The gate refused every turn a person sent while the box had less than 1 GiB free, or while memory PSI
(`full avg10`) stood at 20% or more. Each press got the same notice with a fresh reading, and the only ways on
were to close sessions, wait, or raise the cap. `turns-that-never-ran.md` opens on three of those presses in a
row; the fourth ran because a reading happened to land above the line.

The reading was right. The decision was not the daemon's to make: the person pressing Send knows what the
next turn is worth to them, and the daemon knows only that memory is short. A wall let the daemon's guess
overrule theirs, and they got around it by pressing until it gave way.

## The rule

**A person is told once, then obeyed.** `MemoryWarnings.admit` holds a person's turn on the first short
reading of a spell and admits every turn of theirs after it, however short the box is. The spell ends at the
first reading with room for a person's turn, so a shortage that comes back later is warned about again.

- **Keyed by actor**, the caller as the daemon verified it: a member's email, a token's principal. One member
  going ahead does not answer for a teammate who has not been told. Callers the daemon cannot name share a key.
- **In memory only.** A daemon restart starts a fresh spell.
- **The warning states the stakes and leaves the choice.** It names what is short (resident and swapped apart,
  since their sum can exceed the cap), says that another agent can slow the running ones and that the system
  kills processes if memory runs out, and says the message is held.

## The presses

The hold leaves the words in the composer's queue, as every code on `HELD_FOR_RESEND` does. Sending them again
is the composer's own Send or the notice's **Send anyway**, which releases that queue (`Conversation.resume`).
Either one runs, because the daemon has already warned this person.

A hold that carried a reading also offers **Raise its memory to N GiB** when a connected device can reshape
this sandbox. A stall carries none: pressure says the box is grinding, not that its ceiling is what to move.

Both presses belong to the held message. They show while it is still queued, no turn is running, and the
notice is the conversation's last row, and they go as soon as any of that stops being true. The raise
recreates the container, so offering it next to a running turn would be offering to kill that turn.

## Background work still waits

Unattended turns are schedules, loops, subagents, approved actions and the automations a channel message
wakes. They are refused on every short reading, at double the reserve (2 GiB), and they never warn anyone. Nobody
is at a composer to weigh the risk, and a turn a person sends should find the room first. The refusal is
recorded, because it is the only evidence the run was skipped. Nothing retries it; the next fire is the retry.

Shell commands behind queue-run and the pre-push checks are inside a turn that was already admitted. They wait
for headroom up to a deadline and then start anyway (`waitForMemoryHeadroom`).

## What it was chosen over

- **The wall with a kinder sentence.** It is still a wall.
- **A confirmation on every send while short.** Every send is interrupted, and a confirmation seen that often
  gets clicked without being read. Once per spell keeps the warning worth reading.
- **A warning in the composer before the send.** It would read the periodic sampler's snapshot, not the live
  cgroup files the gate decides on, so it would warn about a box that has recovered and miss one that has not.
  The hold is decided at the moment the turn would start.
- **Once per conversation.** Opening a second conversation would ask again someone who has just said yes,
  which is the wall again one conversation away.
- **Sending automatically after the warning.** That makes the warning a delay, and the point is that the person
  decides.

## What it costs

A person can now start the turn that tips the box into the kernel's OOM killer. That is theirs to decide, and
the warning says it in those words. The latch does not survive a restart, and it cannot tell apart two people
who reach the daemon as the same unnamed caller.
