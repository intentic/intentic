# Chat quick bar

With the chat's home on the rail, every view but `/chat` shows a pill at the bottom of the area. It grows into the
focused chat's own composer, and that pane's transcript can unfold above it. This page covers when each of those
opens and what closes it (`_editor/web/src/features/chat/panel/ChatQuickBar.vue`).

## Hover borrows, a press keeps

The bar sits over the page the reader is working on, so opening it on contact would cover that page every time a
pointer crossed the bottom of the area. Hover opens it only after a short intent delay, and anything hover opened is
borrowed: it folds when the pointer leaves. The transcript folds first (200ms grace, then a 130ms fade), then the box
(400ms grace). A pointer that comes back within the grace keeps both.

A press anywhere on the box's content keeps it: on the composer, on transcript text, on a tool card, on a menu the
composer opened. A kept box stays whatever the pointer does. A borrowed bar used to lose everything a reader does
with a transcript besides reading it:

- A press on transcript text takes the caret out of the composer and gives it to nothing. The old focus rule read
  that as the reader leaving, so the whole box collapsed on the mousedown that started a selection.
- A drag that selects to the end of a line usually overshoots the card. The pointer leaving the box closed the
  transcript mid-drag.
- After a selection, a pointer drifting a few pixels off the edge folded the transcript at once, and the selection
  went with it.

Holding focus counts as a press, and so does a summons (New agent, a board starter). Focus falling to nothing (a press
on text, the window losing focus) is not the reader leaving, so it releases nothing.

## What dismisses a kept box

- **Escape** undoes one thing at a time: the composer's own claims first (stop a turn, drop an edit, quit
  hands-free), then the transcript, then the box. After a press on transcript text the caret is on the body, so while
  the box is kept, an Escape landing on the body is the box's too.
- **A press on the page**, or focus leaving for something on it, always folds the transcript. It also folds the box
  unless the box holds words: a draft keeps the composer so the reader can copy from the page into it.
- **Minimize** on the box's top edge folds it even when a draft is holding it open. Without it, a box holding words
  and no focus had no way closed but typing into it again. The pill shows the draft's first line from then on.
- **Following a link** from the transcript folds the transcript and leaves the composer. Changing the route means the
  reader went to look at something, and the transcript would cover it.

## Inside the box

Anchored menus, dialogs and context menus the composer opens are teleported to `<body>`, outside the box's DOM
subtree. A press or focus landing in one counts as inside. Before this rule, opening the model picker from the bar
collapsed the composer and left the picker hanging over the pill.

## The tools

The open box carries one small cluster on its top edge, wherever that edge is:

- The **eye** toggles the transcript. Hover borrows it. A press keeps it, or folds it if it is already kept. It stays
  lit while the transcript shows, and a dot on it pulses while a turn streams unseen.
- **Open the full chat** goes to `/chat`, for a transcript too long to read in 60vh.
- **Minimize**, as above.

While the transcript shows, the panel pads its top by 12px so the cluster stands on empty glass instead of over a
pinned prompt. The composer's own rect does not move.
