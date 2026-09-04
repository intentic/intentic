# Input audit

A sweep of every place a person types — 128 fields across 418 templates in the kit, the web app, the desktop
shell and the first-party extensions — for controls that mean "type here" and disagree about what that looks
like.

The trigger was a report: *some inputs on focus have highlighted border, other have background, sizes and their
colors also differ.* All of it was reproducible, and none of it was anybody being careless. It is the button
sweep's finding one control over (`button-audit.md`): what happens when the cheapest way to get a field is to
type one.

**Everything below has been acted on.** Each section states what was wrong and what replaced it. 7 of the
findings were user-visible defects rather than untidiness and are marked ⚑.

---

## What the sweep found

Counted over every tracked `.vue` template, with `<script>`, `<style>` and comments blanked so a design note
quoting markup is not mistaken for markup. Fields are `<input>` and `<textarea>` a person types into —
checkboxes, radios, sliders, colour wells and file pickers are different controls and are not in this count.

| | before | after |
| --- | ---: | ---: |
| fields | 128 | 128 |
| …on the design system | 82 | **128** |
| …drawn by hand | 46 | **0** |
| distinct **focus** treatments | **9** | **1** |
| distinct height / padding-y answers | 14 | 2 † |
| distinct type sizes | 11 | 2 † |
| distinct backgrounds | 5 | **1** |
| distinct radii | 4 | **1** |
| distinct rim colours | 4 | **1** |
| fields whose focus ring paints outside their own box | 6 | **0** |
| fields that suppress focus and put nothing back | 8 | **0** |
| fields that zoom mobile Safari on focus | 124 | 10 ‡ |

† Two by design: the 38px control for a page or a dialog and the 26px one for a dense surface, which are the
button's two sizes exactly.

‡ Not a leftover — a conflict, named. The nine `ui.inputInline()` renames take the size of the text they stand
in (`font: inherit` IS the variant), and `CodeField`'s textarea has to match the `<pre>` stacked under it to the
pixel or every caret lands in the wrong place. Raising either to 16px on a phone breaks the thing that makes it
work. Every field that can take the floor does; these two say why they cannot, in the code.

The zeros are held there by `pnpm check:inputs`, described at the end.

---

## 1. Focus had nine answers, and the most common one was the hover state

**What it was.** `ui.input()`'s own base said `focus:border-line-strong focus:outline-none` — and
`hover:border-line-strong` two classes earlier. At **90 of the 128 fields**, focus and hover were byte-identical,
while `outline-none` threw away the browser's own ring. The only thing telling a reader where their keystrokes
were going was the caret.

⚑ Eight fields carried `focus:outline-none` with *nothing* put back — focus suppressed outright. Nineteen more
had no focus rule at all. Two used `focus:border-primary-500`, one `focus:ring-1 focus:ring-primary-500`, and
five wore a `ring-1 ring-primary-500/50` that was **never focus-scoped**, so it was lit the entire time the
field existed. `base.css` has no focus rules, so there was no app-wide policy to drift from: all nine were
call-site guesses.

⚑ The flat scheme was strictly worse than the skin. Sanctum draws a gold rim and an accent halo on focus; the
default theme drew a neutral hairline that was already there. The theme most people use had the weaker signal.

**Now.** One rule, in `primeng.css`, reading three variables from `tokens.css` so a skin re-points rather than
re-implements: the rim goes to the accent, a soft accent ring sits just inside it, and a transparent `outline`
keeps Windows High Contrast able to mark the field. The error state is the same contract with two variables
moved, so an invalid field that is also focused shows one state instead of two.

## 2. Every ring painted outside its box, and that is the part that keeps getting repaired

⚑ Six focus rings in the tree — five hand-written `ring-1`s and the chat composer's `focus-within:ring-2` —
were drawn **outside** the border box, along with the skin's own `0 0 0 3px`. That fails two ways and both were
shipping:

- it lands on top of whatever sits a few pixels away in a tight flex row; and
- it is **cut off** by any ancestor with `overflow: hidden` or `auto` — every scroll pane, rounded card and
  dialog body in the app. The composer is the worst case: it is pinned to the bottom of the transcript's
  scroller, which is exactly the container that clips it.

A half-drawn focus ring reads as a rendering bug, and the call site can never see the ancestor that clipped it,
which is why this kept coming back.

**Now.** The whole focus state is drawn **inward** — `box-shadow: inset`, and an `outline` at a negative offset
for the forced-colors case. It costs zero pixels outside the element, so it is correct in a scroller, flush
against a panel edge, and in a row of fields four pixels apart, and it adds no layout size, so nothing shifts
when focus arrives. Sanctum's halo moved inward for the same reason; its buttons keep an outward one, because a
plate lifting off the wall is what that ring is for.

`check:inputs` refuses `ring-*`, a positive `outline-offset` and a focus-scoped `shadow-*` on anything field-shaped.
A resting `shadow-*` is untouched — a drop shadow on a floating surface is a decoration, not a focus state.

## 3. A hand-drawn field is invisible to the skins, and four were invisible even when correct

⚑ `sanctum.css` reached fields by element and type: `textarea`, `input[type="text"]`, `"search"`, `"email"`,
`"password"`, `"number"`. That list is a promise that has to be renewed every time somebody writes a new
`type=`, and it had already lapsed — the app also ships `url` (×2), `time` (×1) and `datetime-local` (×1). Those
four sat on a carved-stone surface as flat dark boxes: no recess, no gold rim, and no call site able to see why.

**Now.** The field is a **class**, and that is the main reason this change touched CSS at all. `.ui-field-box` is
one selector that cannot go out of date, and it is also the only kind of thing that can be promised to an
extension bundle by name (`opt-in/extension-surface.css`) — an arbitrary Tailwind string never could.

## 4. Size was a free choice, and a third of the call sites paid for it

**What it was.** `ui.input()` shipped one size. **33 of its 82 call sites passed geometry straight back in** to
get out of it: `text-xs` ×16, `py-1` ×7, `px-2` ×5, `py-1.5` ×4, `text-base` ×3, `py-0.5`, `min-h-[2.25rem]` —
seven spellings of "smaller than the form size", picked by whoever was in the file. That is the buttons' retired
`px-2.5 py-1 text-2xs` verbatim.

**Now.** Two sizes, and they are the surface's answer:

- `ui.inputSm()` — the compact 26px control: a row's cluster, a toolbar, a card's action strip.
- `ui.input()` — the 38px control, for a field standing in a page or a dialog.

They are the button's two heights exactly, so a field and a `<Button>` sharing a form row line up instead of
sitting two pixels apart.

## 5. Mobile Safari zoomed on 124 of the 128

⚑ iOS zooms the page when a field under 16px takes focus, and it does not zoom back — the reader is left panning
a page that used to fit. Four call sites knew that and wrote `text-base … md:text-xs` by hand, one of them with
the reason in a comment. The other 124 did not.

**Now.** The floor is in the class, at 16px, restored to the design size at `md` where a viewport that wide is a
pointer and a keyboard. It is baked in for the reason `touch-target` is baked into `ui.iconButton()`: it is owed
by every one of them, and remembering it at a hundred call sites is not a thing that happens.

## 6. The recipe had a second copy, and the second copy had drifted

`<Picker>`'s bordered trigger — the app's replacement for `<select>`, which sits in form rows beside text
inputs — spelled the field out itself: `rounded-md border border-line bg-canvas px-3 py-2 text-sm text-content
hover:border-line-strong focus:border-line-strong focus:outline-none`. Being a copy, it had already lost things:
no disabled fade at the app's one opacity (it had its own `opacity-40`), no placeholder rule, and the same
focus-equals-hover defect. It wears `ui-field-box` now.

## 7. `field-bare` was a marker class with no rules, and its wrappers each invented a focus state

`field-bare` — a field whose frame belongs to the box around it — existed only to be *excluded* by the skin. The
actual "no chrome" was six utilities repeated at each call site, and the **frame** was drawn by whatever
happened to wrap it. Six wrappers did that, and five of them landed on `focus-within:border-line-strong` — the
same neutral the box already goes to on hover, which is finding 1 one level up and invisible from inside the
field, because the field is not the thing drawing it.

⚑ The sixth was the chat composer, with the outward `ring-2` from finding 2.

**Now.** `field-bare` means what it says, and `.ui-field-shell` is the box it sits in: the same rim, the same
fill, the same inward ring on focus. A reader cannot tell whether what they are typing in is one element or
three, which is the point — an assembly with a `$` prefix or a row of glob chips has to look like the plain
field beside it.

## 8. Retired spellings

- `.ui-field-input-error` was a lone `border-color: … !important`. It won against the rim and lost to nothing
  else, so a focused invalid field was a red border with an accent ring inside it. `.ui-field-error-box`
  re-points the rim and focus variables instead, and needs no `!important` and no focus rule of its own.
- `text-[0.8125rem]` at three call sites in the file tree — an arbitrary value inside a scale that has steps,
  and one that cannot be promised to an extension.
- Ten "rename in place" fields spelled six ways across three radii, four type sizes and three backgrounds are
  one variant now: `ui.inputInline()`.

---

## What was deliberately left alone

**The two embeddable widgets.** `_sandbox/issue-widget` and `_sandbox/webchat-widget` ship into third-party
pages with no Tailwind and no design system — the webchat one computes WCAG luminance against a caller-supplied
accent. They cannot import any of this, and pretending otherwise would mean a third copy of the recipe.

**The volume slider.** `MediaViewer`'s `type="range"` is a scrubber: a track and a thumb, no rim, no fill, no
placeholder. It shares the word "input" with a text field and nothing else.

**Checkboxes and switches.** Already themed centrally through PrimeVue (`primeng.css` has the notes), already
consistent, and not part of what was reported.

**`.ui-search-row`.** A search field's focus is a *tint*, not an edge, and the reasoning in `utilities.css` is
still right: these are edge-to-edge inside a panel that already has a border, so a rim drawn around the field
lands as a second frame a few pixels inside the first. It is a different answer on purpose, and it is one answer.

**`ProseField`'s type size.** A writing surface has a legibility floor of its own (`prose.css`), and it is
larger than the field scale's. It keeps it, and now takes the 16px mobile floor on top rather than under.

**`CodeField`'s 12px.** Its `<textarea>` is a transparent sheet stacked over a coloured `<pre>` in one grid
cell, and the two line up only while their metrics are identical — a field one step larger than the text it is
transparent over puts every caret in the wrong place. Both elements read the same class, so they cannot drift;
what they cannot do is take the mobile floor, because a code editor at 16px on a 390px screen is about thirty
columns.

## What keeps it

The `inputs` check (`_tools/checks/input-tiers.mjs`), in the shape of `buttons` and on the checks manifest, so
`pnpm checks` runs it everywhere the list is read. It refuses six things: a field wearing none of the design system's classes; a hand-written focus
answer; a bare `outline-none`; **a focus ring that paints outside the border box**; a call site restating the
field's own geometry; and a type size off the scale.

Two decisions in it are worth knowing, because they are what make a rule this broad safe to run over an app
this size:

- **Side padding is not geometry.** `pl-8` is room for the search glyph the caller drew and only the caller can
  see; `px-2` is the control's own scale. Refusing both would report every field with an icon in it, which is
  how a check earns the reputation that gets it switched off.
- **Two variants own their own box, and that is stated rather than overlooked.** What `field-bare` and
  `ui-field-inline` replace is not one shape — a tree node is a line, a terminal tab is a pill, the chat rail's
  rename is a whole card. `ui.addTile()` is the same call one control over.

Exceptions go in `ALLOWED`, keyed by file *and* by the exact finding, carrying the reason. There are two: the
`SearchBar`, whose recipe is computed because its right-hand room depends on how many controls the bar has, and
the sandbox title, whose box is pinned to a hidden sizer twin so the heading and the field measure the same. An
entry that stops matching is reported as stale, so the list cannot outlive the code it excuses.

The other half of the answer is `/design-kit` (dev-only). It used to print one field, at rest. It now prints
every variant against rest, invalid and disabled, plus two fields four pixels apart inside a clipping box —
because the two things that had drifted were never on screen together.
