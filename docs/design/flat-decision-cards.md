# The flat decision card, and the question card drawn on it

Why the cards a user answers in the chat transcript carry no ground and no rim, and what replaced the box
once it was gone. The subject is `_editor/web/src/features/chat/transcript/cards/` and the card block in
`_editor/web/src/features/chat/panel/chat.css`.

## 1. What was removed, and what it left behind

The transcript went flat in one pass: the thinking fold, the todo list, the errand and notes buttons and
then `ChatCard` itself each lost their surface (`chat-surface`, `bg-overlay/40`, `border-l-2`, the skin's
carved plate). What is left is text on the panel's own ground, held together by where it starts.

That pass stopped at the card's edge. Inside the question card, four option rows still carried
`rounded-lg border` each, so the one element in the transcript a user has to act on read as **four boxes
floating inside nothing**: the children were heavier than the parent, and the ask above them looked like a
caption on the first box rather than the question the boxes answer. The skin was worse off still — its
rules were written against `.chat-card`, a class the flattening had deleted from the DOM, so sanctum was
painting an option border it could no longer reach and re-colouring a plate that no longer existed.

## 2. The claim

**A card with no frame is held together by one text column.** Three measures, declared once on `.chat-card`
and spent by everything under it:

| Measure | What it is |
| --- | --- |
| `--chat-card-inset` | the side margin every band on the card starts at (14px) |
| `--chat-card-mark` | the box the leading glyph sits in — the header icon's own type tier |
| `--chat-card-gap` | the space between a mark and what it marks (8px) |

The header is a grid of `mark | title`, an option row is a grid of `mark | label + description`, and the
free-text field is padded by `inset + mark + gap`. So the question, each sub-question, every option label
and the reader's own typed answer start on **one edge**, with marks hanging in a gutter to their left.
Nothing states 36px; it is `inset + mark + gap` wherever it is needed, and `--chat-card-mark` is written as
the icon's type tier rather than as 14px, so the column follows the scale when a popped-out panel lifts it.

## 3. The options are a list, not a stack of boxes

Rows run **full-bleed** — the negative margin is the body's own inset handed back — for one reason: a wash
that reaches both edges reads as a chosen *line*, which is the claim `.ui-row-select-on` already makes in
every other list in the app, while a wash inset on all four sides reads as a filled box, which is the thing
being removed. The row keeps `.ui-row-select`, so hover, selection, the focus ring and every skin's
override of them arrive for free and a reader who has learned selection anywhere else has learned it here.

Three things say a row is picked, and they survive each other's absence: the mark changes shape
(circle → check-circle, square → check-square), the mark takes the accent, and the row takes the wash.
Sanctum answers the wash in gold with a bar down the edge; the app answers it in the accent.

What is *not* on the card: any rim at all, except the one around the Other field. A field is the one thing
here you put something into, and a frame is what says so.

## 4. The pieces that had a box of their own

**The mock-up an option carries** (`preview`) was a `border border-line bg-canvas` block. `bg-canvas` is
darker than the card, so a sample drawn on it recedes out of the option it belongs to — the same inversion
the in-card document had, argued out in `chat.css`. It is now a wash of the content ink, no rim, `pre`
preserved so an ASCII layout keeps its shape, and the mono tier one under the sans beside it.

**The settled card** keeps every option it was chosen over, which is the point of leaving it in the
transcript: the answer is only informative next to what it beat. With no rim anywhere, the quiet wash on
the taken row is the whole of what separates it from the rest, and a check in the gutter is what carries
that into greyscale.

## 5. The ask outranks the answers by weight

The chat column runs on the app's three type tiers and a card's question sits at the body tier, because it
is a sentence and a sentence reads at the size of one (`chat.css`, the type-scale block). With the frame
gone, size can no longer separate the ask from the labels answering it — in the default skin both were
`text-xs font-medium`, i.e. identical. A prose card title and a sub-question are now `font-semibold`. That
is the whole of the hierarchy: one weight step, one icon, and the column.

## 6. Consequences

- `ChatQuestionCard.vue` is its own component, since the card owns real state (picks, typed answers, a
  draft mirrored per request id) that no other card has. `ChatMessageView` passes the card and takes
  `answer`/`dismiss` back, so the conversation stays the caller's.
- The card files moved into `transcript/cards/`, which also takes that directory back under the file-count
  gate it had already crossed.
- Sanctum's card rules are three: the glyph's ink, the ask's gold, and the settled pick's wash. The plate,
  the tooth and the border overrides went with the box they were drawn on.
