# Marks in the lane: what a transcript says without saying it

Why the turn's thinking, the context the sandbox prepends to a prompt and an app-sent errand stand in the
margin as a glyph and a count rather than as bars across the column, and what everything they open is drawn
on. The subject is `_editor/web/src/features/chat/transcript/ChatAsideLane.vue`, its three callers, and the
`.chat-mark-*` and `.chat-inset` blocks in `_editor/web/src/features/chat/panel/chat.css`.

## 1. What was wrong

All of it rode on one component, `ChatFold`: a `w-full` button — icon, label, the first words of whatever it
hid, chevron pinned to the far right edge — opening to a `max-h-64` scroller.

Two of them landed between the prompt and the answer, which is the highest-attention slot the column has,
and the material they carried was the least interesting in it. "Sent with your message" is the sandbox's own
preamble: the project map, the skill catalogue, how to read a message beginning with a slash. Five notes,
whose titles ran together into a truncated line the width of the pane, and whose text opened concatenated
into a 16rem porthole — so finding the one note worth reading meant scrolling past four that weren't, inside
a scroller, inside the transcript's scroller.

The hit target was the whole pane width for something nobody presses.

## 2. The claim

**Everything an agent was GIVEN or THOUGHT stands in the lane past the column.** A hidden run of tool calls
already did (`ChatToolRun`, since folded into `ChatAsideLane`): a glyph, a count, a hairline ring, out past
the reading measure where it takes no width from the conversation and costs half a line of height. That mark
was the answer; it just had one caller.

So there is no second placement to learn, and nothing needed a new icon to carry a distinction:

| Aside | Mark | Opens to |
| --- | --- | --- |
| Notes the sandbox prepended | `paperclip` + how many | the list of titles, each opening to its own words |
| The turn's thinking | `sparkles` | the thought |
| An errand's exact words | the errand's own glyph | the prompt the app sent |
| A hidden run of tool calls | the most notable call's glyph + how many | the rows the shown mode draws |

The name is on hover and on `aria-label`, because the lane is 5.75rem and "Sent with your message" is not.

## 3. One bar per row, not one per mark

A mark is positioned against its bar (`top: 50%`), and a bar's whole height is its padding — 0.5rem. Two
bars stacked in one message put their marks 0.5rem apart while each is 1.4rem tall, which is two marks drawn
on top of each other in the margin.

So the bar belongs to the **row**, not to the aside: `ChatAsideLane` takes a list of marks, lays them out in
one `.chat-mark-lane`, and opens one body at a time under them. That is why `ChatTurnAsides` exists at all —
an assistant turn's thinking and its hidden run are one row's worth of marks, and something has to own the
bar they share. It also means a reader never has two things open under one bar arguing about which the bar
is for.

## 4. What is NOT a mark

**An errand is a turn**, not an aside on one. A mark with nothing in flow beside it would make a turn the
app sent on the user's behalf look like a turn that came from nowhere. So it says one quiet line *on the
mark's own bar* — worded exactly as the trailer a *folded* errand already leaves on the prompt above it,
`↳ label · reason` — and the words it actually sent go on the mark like everything else. A bar with
something to say keeps its height when opened; an empty one folds to nothing and lets the material have the
row.

**Tool calls a reader asked to see** are rows, not a mark. That preference is the whole of the question the
mark otherwise asks.

## 5. `bg-canvas` is a hole, not a surface

Everything opened in the transcript used to be `rounded border border-line bg-canvas`. Canvas sits *below*
the panel, so a box drawn on it reads as a hole cut through the turn rather than a part of it, and the
`text-subtle` ink inside dims by the same step — grey text on near-black, inside a rim, at 11px.

`.chat-inset` is the one surface all of it is drawn on now: a wash of the column's own ink, no rim, the
column's own radius. It is opaque rather than an alpha wash so a sticky gutter inside one (the Read card's
line numbers) can reuse the fill and still hide what scrolls under it. This is the card option preview's
answer (`flat-decision-cards.md` §4) spent everywhere else in the transcript.

## 6. Two radii

The column had four — `rounded` (0.25rem) on tool output, `rounded-md` on the prompt toggle and a code body,
`rounded-lg` on the bubbles, and the mark's pill — mixed rather than laddered, which is what made an opened
tool call look like a different app from the message above it.

**`--radius-lg` for every surface standing on the transcript's ground; a pill for a mark.** One step down
(`--radius-md`) is kept for the two things that sit *inside* another surface — a held command inside a
permission card, a hover row inside an inset — where a curve equal to its parent's reads as a mistake.

## 7. Consequences

- `ChatFold.vue`, `ChatThinking.vue` and `ChatToolRun.vue` are gone. `ChatAsideLane.vue` is the bar and the
  marks; `ChatTurnAsides.vue` is an assistant turn's two of them, shared by the chat and the Subagents page
  so a delegated agent's record reads as the conversation does.
- Subagents draws a child's tool calls after its prose rather than before it, which is the order the chat
  has always used; sharing the component is what settled it.
- The notes row stays a sibling of the prompt rather than moving inside the bubble's own stack. A pinned
  prompt charges its whole height against the room its answer is read in, and the preamble is the last thing
  that should be paying that.
- `.chat-run-*` is `.chat-mark-*`: the lane is no longer the tool run's, and the e2e shot that presses it
  names the run by its label rather than by the bar's class.
