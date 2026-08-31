# Button audit

A sweep of every `<button>` and `<Button>` in the repo — 411 templates across the kit, the web app, the desktop
shell, the share view and the first-party extensions — for controls that mean "press me" and disagree about
what that looks like.

The trigger was a report, with screenshots: *at least a few different intensities of borders and text colour
inside, as well as very different button sizing.* All of it was reproducible, and none of it was anybody being
careless. It is what happens when the cheapest way to get a button is to type one.

**Everything below has been acted on.** Each section states what was wrong and what replaced it. 10 of the
findings were user-visible defects rather than untidiness and are marked ⚑.

---

## What the sweep found

Counted over every tracked `.vue` template, with `<script>`, `<style>` and comments blanked so a design note
quoting markup is not mistaken for markup:

| | before | after |
| --- | ---: | ---: |
| `<Button>` | 369 | 425 |
| bare `<button>` | 544 | 491 |
| …of those, **drawn as an action button** by hand | 68 | **0** |
| …drawn as a pill by hand | 20 | **0** |
| …an icon affordance sized by hand | 29 | 5 † |
| `disabled:opacity-*` written at a call site | 38 | **0** |
| radii used by a hand-drawn action button | 4 | — |
| padding pairs used by one | 9 | — |
| text colours used by one | 6 | — |

† The five that remain draw a border and a fill **at rest**, which is what makes them not icon ghosts: an
avatar tile you can replace, two floating overlay controls, a stage circle on a job graph. The check knows the
difference and leaves them alone; the reasoning is at the end.

The zeros are held there by `pnpm check:buttons`, described at the end.

---

## 1. Two button systems, and only one of them could be themed

**What it was.** `<Button>` was in good shape: 369 usages, and only 8 of them overrode any geometry. Beside it
lived 117 bare `<button>` elements drawing a button by hand — 68 action buttons, 20 pills, 29 icon
affordances — out of 544 `<button>`s in total (the rest are rows, tiles, tabs and menu lines, which are a
different control and stay one). Those 117 were not a fringe: they were the file viewer's toolbar, the settings
pages' actions, the review panel's row verbs, the human-help hand-back pair, the chat's notice strips, and most
of the icon affordances in the workspace.

The cost is not that they were untidy. **A skin restyles `.p-button`** (`_editor/web/src/skins/README.md`), so
it reaches every real `<Button>` and none of the hand-written ones. Under Sanctum the app's committing button
is a pale carved stone plaque; a hand-styled button beside it is a dark box. Same word, two materials,
permanently, with no call site able to see why.

⚑ The screenshot that started this was **`Preview` rendered two ways on one screen** —
`_extensions/preview/src/PortRow.vue` picked its tier from a `muted` prop
(`v-bind="muted ? { severity: 'secondary' } : {}"`), so the same verb was a committing plaque in one group and
a neutral fill three rows down. The de-emphasis that prop existed for is already stated on the group
(`opacity-70` in `PortsView`); the prop is gone.

**The duplicates it was hiding.** `Download` written four times in four files in two recipes, one of them
missing its transition. `Abort` twice, in two repositories. `Restore` twice on one panel in two tones. The pair
`Done: hand back` / `Can't help now` duplicated verbatim between `Browsers.vue` and `TerminalPanel.vue`. Four
settings-page actions in four spellings, one of which (`Apply theme`) was a fifth tier nobody had named.

**Now.** Every labelled control with chrome is a `<Button>`: tier by role, size by surface. The four controls
that are deliberately *not* it are named and documented in `_editor/ui/src/lib/ui.ts`:

- `ui.iconButton()` — a bare glyph affordance, no chrome until hover, coarse-pointer target baked in
- `ui.linkButton()` — an inline text action that will **navigate**; link-toned, underlines on hover
- `ui.textAction()` — the same control in the quiet tone, for a verb that acts in place (new)
- `.ui-chip` / `.ui-chip-on` — a pill that carries a **state**: a filter, a lane, a mode (new)

---

## 2. Disabled had five answers, and the loudest one was invisible

**What it was.** PrimeVue's `opacity: 0.6` for `<Button>`, plus `disabled:opacity-30`, `-40`, `-50` and `-60`
hand-written across 38 call sites.

⚑ The fade was the wrong instrument for this design system specifically, and the reason is arithmetic. Every
tier here is a **tint** — `color-mix(… 10%, transparent)` — so 0.6 of a 10% wash is a 6% wash. On canvas that
is nothing: the fill and the hairline both vanish and what is left is a dim word floating where a button was.
The toggle switch had this exact bug and was fixed the same way (`theme.ts`); the note there is the general
rule, *hold the shape and drop only the contrast*.

⚑ Under Sanctum the disabled committing button was `#38342e` — **the wall's own value**, against the live
plaque's `#b3a794`. So a form's one action, sitting disabled until its field validated, was not a dimmed
version of anything: it was a dark rectangle where a pale object had been. That is the `Invite` screenshot.

⚑ The four hand-mixed Sanctum disabled tones measured **3.0–3.3:1**, under a comment claiming 4.5.

**Now.** One contract, three variables (`--ui-button-off-*` in `tokens.css`), which the skins re-point rather
than re-implement:

- A disabled button **has no lit edge**, and that is the part doing the work. Every live tier draws a 1px
  hairline in its own tone; the two that do not (`text`, `link`) have no fill either. So a filled box with no
  edge that catches light is a shape nothing live can wear. The border is still declared — `transparent` in
  the flat scheme, a shadow seam under Sanctum — so the box never changes size when it goes off.
- Its fill sits **under** the quietest live tier (4% against `secondary`'s 8%) and the label drops to
  `subtle`. One neutral ground for every tier — a disabled `danger` must not still be red.
- Under Sanctum it is an **uncarved blank**, and that phrasing is the design rather than a metaphor. The skin
  builds a button from four layers, each meaning something: the *tooth* is the material, the *mottle* is the
  vein, the *pits and their lit lips* are the dressing a chisel leaves, and the *incision* is the label. A
  disabled control is a panel of the same rock, set in the wall, that nobody has dressed and nobody has
  inscribed — grain and vein, no pitting, no lit lips, no incision. It reads as unavailable the way a blank
  pediment does: not because it is greyer, but because the work has not been done to it. Ink `#968c7d`, 4.4:1
  against the live neutral label's 10.5:1.
- Its edge is a **seam**, not a rim: the shadow in the gap around something set *into* a surface. Every live
  tier draws an edge that catches light; this one draws the absence of light around it. In the flat scheme,
  which has no material and no gap, that same rule is expressed as no edge at all.

  ⚑ This took three passes and each failure is recorded in `skins/README.md`. (1) The wall's own value, so the
  button read as *gone*. (2) Each tier's own material at 28% less light — worse, because a pale plate is
  Sanctum's loudest "press me" signal and a slightly dimmer one is a button that looks pressable and isn't.
  (3) Material *and* relief both dropped, which overshot: `background-image: none` left the one surface in the
  skin with no grain, and a half-black inset smear across its top edge — the 1990s pressed-input emboss the
  file explicitly talks itself out of thirty rules earlier, for the plaque. Separately, in both schemes, a
  disabled plate whose fill and rim were each a few per cent under `secondary`'s simply **is** `secondary`,
  which is why it was hard to tell a disabled control from a quiet one.
- The borderless tiers keep having no chrome. A control that *gains* an edge by becoming unavailable is
  answering the wrong question.
- ⚑ **`loading` is excluded.** PrimeVue reports a Button as disabled while it is loading (`disabled || loading`),
  so without the exclusion every button in the app would repaint itself as unavailable for the whole of the
  wait it had just started — the exact moment a person is watching it to find out whether their press landed.
- For the controls the kit does not paint — a row, a tile, a menu line, a field — the fade is still right, and
  it is one number now: `.ui-off`, `--ui-off-dim`.

---

## 3. The quiet tier had chrome under both skins

⚑ `sanctum.css` set `border-color`, an inset bevel and a drop shadow on **every** `.p-button`, with no
exclusion for `.p-button-text` / `.p-button-link`. PrimeVue's transparent border came back as a gold hairline,
and the bevel gave a control that is meant to be a *word* the silhouette of a plate. `hud.css` did the same
with a wash and a glow.

That tier is defined as *no chrome at all* — Cancel, Dismiss, an inline escape hatch, and the whole of
`<SandboxVerbs>`, which is the `Start` / `…` cluster on every machine row. That is the second screenshot: two
controls that should be bare words, drawn as outlined boxes.

Both skins now exclude the borderless variants from the plate and from its hover, spelled with `:where()` so
the exclusion costs no specificity and the plaque's own bevel still wins.

---

## 4. Size was a free choice

**What it was.** 271 `size="small"` against 103 default, picked per call site. `<RowGroup>`'s density taxonomy
is the same lesson one control over, and `_tools/scripts/row-tiers.mjs` records what that cost.

**Now.** Size is the surface's answer:

- `size="small"` — the compact 26px control, and the app's default. Any dense surface: a row's trailing
  cluster, a card's action strip, a toolbar, a section header, a chat notice.
- no `size` — the 38px control, for a button standing on its own in a **page** or a **dialog**.

Two halves of that are decidable from markup and are enforced. A `<Button>` in a row's `#control`, `#actions`,
`#meta` or `#lead` must be `small` — what a row *expands* to show is deliberately exempt, since an edit form's
footer nested in a list is a page and gets a page's size. And **direct siblings must agree**: a 26px control
beside a 38px one in one `justify-end` row is what "the buttons are different sizes" looks like when somebody
reports it. A dialog's footer and its body are two surfaces and may still differ.

⚑ `HostRecreate` — the sandbox's Update / Download / Rebuild / **Roll back** button — was drawing at the
default size inside cards whose other controls are all compact, and its two branches disagreed with each other
besides. No check can see that one: the component's own template contains no surface, so the size is a
judgement about every place it is mounted. If a component's whole job is to be dropped into a card, its
controls are the card's.

---

## 5. One tier's rim was drawn at the wrong number

⚑ Sanctum gives `secondary`, `danger`, `warn` and `success` one formula and one percentage for their border:
30% of the tier's tone. That is right for a formula and wrong for a percentage, because the tones are not
equally bright — the three status tiers mix a mid-lightness hue, and `secondary`'s tone is `--color-content`,
the cream the whole skin writes in and the lightest colour in the palette. The same 30% therefore drew the
loudest edge on the screen around the **quietest** tier: reported as the neutral buttons standing off too much,
and on a card of dark plates the brightest line in view belonged to the button that is meant to recede.

It has its own number now, 16% at rest and 28% on hover, which lands its rim at about the weight the status
tiers' already carry. The fill is untouched: that is what says "this is a control", and it was never the thing
that shouted.

---

## 6. Colours the theme could not reach

⚑ Four controls pinned themselves to one step of the palette with `bg-primary-600` + `text-white`: the
human-help hand-back button (twice), the browser "driving" toggle, and a menu row's active highlight. The
accent is a runtime choice — there is a picker — and both skins repaint it, so those four opted out of all of
it. Invisible until somebody switches theme, which is why it had survived.

They take the tier or the fill tokens now. The menu row takes `ui-row-select-on`, which is what every other
list in the app highlights with.

---

## 7. Retired spellings that had grown back

- `:outlined="true"` survived at one call site (`AgentCard`), wearing five `!`-overrides
  (`!px-2 !py-0.5 !text-2xs !text-muted hover:!text-content`) — a whole visual tier written out in `!`
  utilities because the vocabulary appeared not to have one. It has one: `severity="secondary" :text="true"`.
- `:rounded="true"` on four "remove" ✕ buttons made them circles, a fifth shape nobody had chosen. The only
  circle left in the app is the mobile upload FAB, which is waived by name.
- Two download buttons on `SetupRunDetails` had grown a bespoke hover (`hover:-translate-y-px`,
  `hover:shadow-sm`, a different border and fill). The neutral tier has a hover.
- `max-md:h-11 max-md:px-5` on the chat's decision answers became `.ui-button-thumb`, a named tier — and moved
  from a width breakpoint to `pointer: coarse`, because a narrow desktop window is not a thumb and a tablet in
  landscape is.

---

## What was deliberately left alone

**Text links inside a sentence.** About forty `<button class="text-link hover:underline">` sit in prose — inside
a `<p>`, between two words, followed by a full stop. They were the one cluster in the sweep that was *already*
uniform (that exact string, at 25 of them), and `ui.linkButton`'s geometry is wrong for them: it is a 36px
thumb target with negative margins, which is right for a standalone action and would visibly change the line
height of a paragraph. They are links, not buttons, and the vocabulary does not claim them. The standalone
text actions — the ones in a flex row or column, where the missing tap target was a real defect on a phone —
did move onto `ui.linkButton` / `ui.textAction`.

**Rows, tiles, tabs and menu lines.** 491 `<button>` elements remain, and almost all of them are these. A row
is not a button and forcing it through the button vocabulary would make it worse; `<RowGroup>` and
`.ui-row-select` are what own that shape, and `check:rows` is what keeps it.

**Five square affordances that draw their own border and fill.** An avatar tile you can replace, two floating
overlay controls, a stage circle on a job graph. They are square and pressable, and that is all they share with
a toolbar glyph.

## What keeps it

`pnpm check:buttons` (`_tools/scripts/button-tiers.mjs`), in the shape of `check:rows` and wired into
`pnpm check`. It refuses nine things: a bare `<button>` drawn as an action button; a hand-drawn pill;
a hand-sized icon affordance; a hand-written disabled fade; a hardcoded solid accent; a `<Button>` that
overrides its own tier's geometry; a `<Button>` in a row cluster that is not `small`; two `<Button>` siblings
that disagree about size; and a retired spelling.

Two decisions in it are worth knowing, because they are what make a rule this broad safe to run over an app
this size:

- **A button centres its label; a row aligns it left.** `text-left` is the exemption, and without it the check
  reports the mobile menu's sheet rows, every picker option and every card tile — which is how a check earns
  the reputation that gets it switched off.
- **An icon ghost has no chrome at rest.** A square box that draws its own border and fill is a different
  object every time — an avatar tile, a floating overlay control, a stage circle on a job graph — and has no
  business being told it is a toolbar affordance.

Exceptions go in `ALLOWED`, keyed by file *and* by the exact finding, carrying the reason. There are two, both
geometry that belongs to the shape of a control rather than to its tier: a split button's seam, and the FAB.
An entry that stops matching is reported as stale, so the list cannot outlive the code it excuses.

The other half of the answer is `/design-kit` (dev-only). It used to show five buttons at rest; it now prints
every tier against every state, because the two things that had drifted were never on screen together.
