# Rows and pills: what a transcript says without saying it

Why the turn's thinking, the context the sandbox prepends to a prompt and an app-sent errand are pills on
an edge rather than bars across the column, and which edge each one takes. The subject is
`_editor/web/src/features/chat/transcript/ChatAside.vue` and its two callers, `ChatNotes.vue` and
`ChatThinking.vue`.

## 1. What was wrong

All three rode on one component, `ChatFold`: a `w-full` button — icon, label, the first words of whatever
it hid, chevron pinned to the far right edge — opening to a `max-h-64` scroller.

Two of them landed between the prompt and the answer, which is the highest-attention slot the column has,
and the material they carried was the least interesting in it. "Sent with your message" is the sandbox's
own preamble: the project map, the skill catalogue, how to read a message beginning with a slash. Five
notes, whose titles ran together into a truncated line the width of the pane, and whose text opened
concatenated into a 16rem porthole — so finding the one note worth reading meant scrolling past four that
weren't, inside a scroller, inside the transcript's scroller.

The hit target was the whole pane width for something nobody presses.

## 2. The claim

**Rows are what a turn did. Pills are what it was given or thought.**

A tool call is a row: chevron, glyph, name, target in mono, result at the right end. That grammar is
already the transcript's record of doing, and an aside must not read as one more thing the agent ran. So an
aside is a pill — `.ui-chip`, the kit's own — which differs from a row in shape, in width and in the fact
that it is obviously pressable at the size it actually is.

The plate a pill carries is not the surface the flat pass took off decision cards
(`flat-decision-cards.md`). A bar spanning the column reads as pressable because it spans the column; a
100px run of text in the middle of one does not, and the 6% wash is what buys that back at a quarter of
the width. `ChatToolRun`'s hidden-run mark already made this trade and kept its plate through the same
pass.

## 3. Which edge

The other half of the answer is placement, and it is not a second vocabulary to learn:

**A pill sits on the edge of the message whose material it is.**

| Aside | Edge | Why |
| --- | --- | --- |
| Notes the sandbox prepended | the prompt's right | they went out *with the user's message*; they are not something the agent did |
| An errand the app sent | the prompt's right | it is a user turn, written by the app on the user's behalf |
| The turn's thinking | the answer's left | it is the agent's own, and belongs in the agent's column beside its tool rows |

The alternative — one lane for everything quiet — was mocked and rejected: a pill about the *user's*
message, hanging under the agent's column, reads as something the agent produced. The margin lane past the
column (where the hidden-run mark lives) was rejected too: it only exists above a 61rem container, it has
room for a glyph and a count but no label, and the edit pencil and the fork mark are already out there.

Nothing needed a new icon to carry the distinction. `paperclip` for the notes says attached-to-this-message
and is claimed by no tool; `sparkles` is the mark the think tool already carries.

## 4. Opened, a list before a wall

The pill states how much was added. Opening it names each note. Opening a note gives that note's words, one
at a time, with the leading markdown heading stripped because the row above it already says the title.

That is three presses to the project map and one to the list, against one press to a scroller holding all
five notes at once. It is the right way round: the question a reader has is almost always *what* went with
the message, not *what every one of them said*.

Boxed output — `rounded border border-line bg-canvas` — is the tool card's own body treatment, so reasoning,
an errand's exact words and a command's output all read as one vocabulary once they are open.

## 5. Consequences

- `ChatFold.vue` is gone. `ChatAside.vue` replaces it: same three callers, `detail` now meaning a reason the
  reader is owed (the errand's "Sent by the app, landing this work refused") rather than a preview of the
  hidden text. The preview moved to the pill's tooltip, where it costs no width.
- The notes row stays a sibling of the prompt rather than moving inside the bubble's own stack. A pinned
  prompt charges its whole height against the room its answer is read in, and the preamble is the last
  thing that should be paying that.
- `ChatNotes.vue` owns the list and the heading strip, which `ChatMessageView` used to carry.
