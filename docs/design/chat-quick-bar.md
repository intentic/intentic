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

Holding focus counts as a press, and so does a summons (New agent, a board starter).

## What dismisses a kept box

- **Escape** undoes one thing at a time: the composer's own claims first (stop a turn, drop an edit, quit
  hands-free), then the transcript, then the box. A press on transcript text leaves the caret on the body, and a
  view switch leaves it on the rail, so while the box is kept, an Escape landing anywhere off the page is the box's
  too. Menus and dialogs keep their own Escape.
- **A press on the page** always folds the transcript. It also folds the box unless the box holds words: a draft
  keeps the composer so the reader can copy from the page into it.
- **Minimize** on the box's top edge folds it even when a draft is holding it open. Without it, a box holding words
  and no focus had no way closed but typing into it again. The pill shows the draft's first line from then on.

## The page, and everything that is not it

The page is the section's own area, the `<main>` the bar floats over (ShellDesktop passes it in). Only a press there
means the reader went back to what the bar covers. The rest of the window is not the page:

- **The rail.** The bar is the parked chat's home on every view, so it follows the reader from view to view. Switching
  from `/workspace` to `/ext/pipelines` on the rail keeps the box and its transcript as they were; folding them there
  made every look at another view cost reopening the chat.
- **Menus and dialogs** the composer opens, teleported to `<body>`. Before, opening the model picker from the bar
  collapsed the composer and left the picker hanging over the pill.
- **Focus moving.** Focus falls to nothing on a press on text or when the window loses focus. A view that opens can
  put the caret in a field of its own. Neither is a gesture, so the caret moving, wherever it goes, releases nothing.

A borrowed box is different: it was never the reader's, so the pointer leaving for the rail folds it like any other
leave.

## The tools

The open box carries one small cluster on its top edge, wherever that edge is:

- The **eye** toggles the transcript. Hover borrows it. A press keeps it, or folds it if it is already kept. It stays
  lit while the transcript shows, and a dot on it pulses while a turn streams unseen.
- **Open the full chat** goes to `/chat`, for a transcript too long to read in 60vh.
- **Minimize**, as above.

While the transcript shows, the panel pads its top by 12px so the cluster stands on empty glass instead of over a
pinned prompt. The composer's own rect does not move.
