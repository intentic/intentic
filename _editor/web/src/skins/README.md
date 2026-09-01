# Skins

A **skin** is a whole-interface look, as opposed to a colour. The accent picker and the light/dark switch both
answer *what colour is this app*; a skin answers *what is this app made of*: what a surface is, what an edge is,
what light does when you touch something.

There is one:

- **Sanctum** (`sanctum.css`): **the site's design system, worn by the app**. Same metals, same ink, same
  materials, same ornament kit as `_site/site/src/styles/global.css`: a near-colourless warm ash ground with a
  whisper of tooth in it, one gold rule round everything, cream ink, and the site's two faces. The rail and
  every overlay are a flat unlit shadow that the icons and the lists sit in; the two filled button tiers are
  plaques with their labels cut into them, one carved stone and one cast bronze. A distant temple stands on the
  floor of the window where the app has put nothing in front of it.

**Its structure is FIXED GOLD, and that is the decision worth reading.** `#c9a05c`, the site's own, whatever the
accent picker says, and the accent is spent only where it means something: a link, a focus ring, a ticked box.
That is not a smaller idea than letting the accent paint the chrome, it is the site's own rule (*structure is
gold, the ember is spent, never spread*) and it is what stopped the skin reading as one warm smear. A skin that
lets the accent paint its hairlines has a thousand of them to paint.

## The rule it keeps

**Every surface a word sits on is flat in the low frequencies, and opaque.** Overlays that cover live text are
solid, never translucent, and no plate ever carries a *gradient*. A wash down the top of a card puts the first
line of a paragraph on a different ground from the last: nothing is unreadable and everything is slightly worse,
which is the expensive kind of wrong because it never announces itself.

A *texture* is not that. A fine, high-frequency speckle has no low-frequency component at all: every square inch
of it averages the same value, so the contrast at the top of a paragraph and at the bottom are the same number.
Sanctum read the rule as "no background-image on a plate" for one cut, and shipped a skin built out of materials
in which every surface anyone actually looked at was a flat rectangle. The plates carry a tooth now, measured at
under a hundredth of a contrast ratio point.

Sanctum has paid for that rule and seventeen others, and the notes are kept at the top of the file:

- **A skin that says `.p-button` has said it about the tiers that are meant to have no chrome.** The skin
  wrote its plate — a border colour, a bevel, a drop shadow, a wash, a hover glow — against every `.p-button`
  with no exclusion, so `text` and `link`, the tiers the app defines as *nothing until you point at it*, came
  out as outlined boxes. It reached the whole of `<SandboxVerbs>`, which is the Start/Stop/… cluster on every
  machine row. Reported as the app having border weights nobody had chosen. The skin excludes the borderless
  variants now, spelled with `:where()` so the exclusion costs no specificity.
- **A disabled control is a STAGE OF WORK, not a colour.** This one went round three times and every round is
  in the file. First it was painted at the *wall's own value*, against a live plaque of pale limestone, so the
  one action on a form read as gone rather than as unavailable. The obvious correction — keep each tier's
  material and take 28% of its light off — was worse: a pale plate is this skin's single loudest "press me"
  signal, so a slightly dimmer pale plate is a button that looks pressable and is not. The third round dropped
  the material *and* the relief, and overshot: `background-image: none` left the one surface in the skin with
  no grain at all, and a half-black inset smear across its top edge — reported as ugly, and as not belonging
  here, which it was: that is the 1990s pressed-input emboss this file talks itself out of for the plaque.

  What settled it was reading the skin's own layers as a sentence. **The tooth is the material, the mottle is
  the vein, the pits and their lit lips are the DRESSING, and the incision is the label.** So a disabled
  control is a panel of the same rock, set in the wall, that nobody has dressed and nobody has inscribed: it
  keeps the grain and the vein, and it has no pitting, no lit lips and no incision. It reads as unavailable
  the way a blank pediment does — not because it is greyer, but because the work has not been done to it.
- **An edge that catches light and an edge that is a shadow are different objects.** Every live tier here draws
  a rim in its own tone — cream, gold, red, amber, green — an edge proud of the surface. Saying a disabled
  control therefore has *no* edge was one notch too blunt: with none at all the blank had nothing to end
  against, and on canvas it stopped being a panel and became a stain on the wall. Its edge is a **seam**: the
  shadow in the gap around something set INTO the surface. Still a shape nothing live can wear, and an object
  again. The whole thing is driven by re-pointing the app's `--ui-button-off-*` variables rather than by a
  block per tier, which is what had let four hand-mixed tones drift to 3.0–3.3:1 under a comment claiming 4.5.
- **One percentage across four tones is four different weights.** `secondary`, `danger`, `warn` and `success`
  shared a border formula at 30% of the tier's tone — but `secondary`'s tone is `--color-content`, the lightest
  colour in the palette, so the quietest tier was drawing the brightest edge on the screen. Reported as the
  neutral buttons standing off too much. A shared formula is right; a shared percentage across unequal
  lightnesses is not.
- **Ornament on an edge becomes noise at UI size.** A carved arcade that reads as stone at 40px reads as a torn,
  dithered edge at 14px: and every panel in an app is a 14px edge. Character has to come from the material, the
  line weights and the type, because those survive being shrunk. The site's turned corner is therefore drawn in
  exactly one place: the dialog, which is the only panel big enough to carry it.
- **A decorative layer that scales with the viewport will eventually fill the screen.** The temple was sized as a
  share of window width; at 1900px it became a lit mountain range across the bottom third. It is capped in
  absolute pixels now.
- **A brown ground makes gold invisible.** The cut before this one ran the stone ramp at three times the chroma,
  at a redder hue, and drew every rule in the accent: so the wall, the plates and the lines were all the same
  warm thing and none of them could be the brightest. The ground lost its colour and the metal kept it.
- **The app's accent tier is six warm chips on a settings page.** `<Button>` tints itself from the picked
  colour, so every committing button came out a warm chip on a warm wall. The severities (`danger`, `warn`,
  `success`) keep their own tones and have to be excluded **by name**: the app sets each one's tone in
  `@layer primeng`, and a skin's `components` layer beats that layer outright.
- **A dark primary on a dark window is not a primary.** The fix for the warm chips was a gold hairline round a
  dark box, and it swapped a loud fault for a quiet one: a dark box inside a warm rule is also the description
  of a card, a field, an input, a chip and a secondary button here. The primary had no property the furniture
  did not share, so a screen had nothing on it that looked pressable: and the only honest report of it was the
  user's, that the buttons had not meaningfully changed. The eye finds differences of *lightness* first.
  Both filled tiers invert now: the committing button is a **carved stone plaque** cut from the wall's own
  rock, `ui-button-loud` is a **cast bronze** one a clear step brighter, and both have their label cut INTO
  them. Two materials, one hierarchy, no colour spent and no second shape: which is the only kind of hierarchy
  that survives being repeated on three hundred screens. The site reached the same conclusion about its own
  hero (see the note over `.btn-primary` in `global.css`), but its plaque is *polished*, and a specular
  highlight that is right for ninety seconds on a page is a lamp in the corner of the eye for nine hours in a
  window: same three layers, a third of the sweep, no outer halo.
- **The emboss is what reads as "1990s", not the colour.** The stone plaque's first cut had a forty-level
  light-to-dark ramp down the body, a near-white hairline on top, a hard dark one at the foot and an inner
  vignette: the exact set every OS toolkit of that era shipped, and the eye has thirty years of practice
  reading it as *widget* rather than as *material*. What replaced it: a flat body, ONE hairline where the top
  edge catches light, and a hard dark line immediately under the plate, which is the contact shadow of an
  object resting on something. Depth is one pixel of darkness in the right place. It also had to get much
  LIGHTER, because a mid-tan plate with a bevel is a beige button, while a pale limestone one with dark cut
  letters is an inscription.
- **A tint mixed into `transparent` is a tint mixed into whatever is behind it.** The app tints its quiet and
  severity buttons with `color-mix(… 10%, transparent)`, which is right on a flat scheme and wrong here: on a
  card the button showed the card's tooth through itself, on canvas it showed the wall's grain and the
  vignette, and dragging the card moved the tint with the ground under it. Mixed into `--color-card` instead:
  same formula, same tone variable, one colour wherever the button is put.
- **A decoration sized in viewport terms may only be painted on a viewport-sized surface.** The wall's vignette
  and temple were painted on `.bg-canvas`, which is not only the window's floor: it is every recess inside a
  panel, including each node box in the workflow graph. With the layers `fixed` to the viewport, a 90px node
  low on the screen showed whatever slice of a distant temple fell behind it. The decorated stack belongs to
  the body and the route element; everything else canvas-painted gets the grain, which has no size to be wrong.
- **Beware `:where()` in a tier selector.** The button tiers are matched with `.p-button:where(:not(…))`, which
  keeps the exclusion list readable and contributes **nothing** to specificity: so a tier's base rule sits at
  one class while a generic `:enabled:hover` sits at three. Every tier that paints a `box-shadow` has to repaint
  it in its own hover rule, or the plaque visibly sinks into the page the moment a pointer arrives.
- **A light texture raises the ground it lies on.** The wall's tooth lifted the canvas by about five luminance
  levels, so a canvas token written at the app's own value *shipped* lighter than the app's: and the plates lost
  most of their step off it, which is why cards started reading as panes of glass. Surface tokens under a
  texture have to be chosen against what renders, not against what is written. Anything else keyed to the wall
  (the temple's alpha, the lane's fill) has to be re-checked whenever it moves.
- **The navigation rail is not a surface, it is a gap.** Three cuts spent the skin's material budget on it:
  timber, then cloth on a brown ground, then the same cloth on the app's own `bg-card`: and each one failed
  differently: a directional grain has room for three strokes across 48px, a colour of its own makes a seam
  against the panel beside it, and a weave has a slow component that never averages out over a column that
  narrow. The answer was that you look *past* a rail forty times a minute, so anything in it is something to
  look past. It is flat, unlit, and a step deeper than the wall now. The overlays followed it there for the
  same reason: a context menu is a thing you look *through* to a list of names.
- **"In front" is a relationship, not a value.** The overlays used to sit a step ABOVE a card because that is
  what floating usually means. But every plate in this skin is lit (bevel, ledge, drop) so a panel that goes
  the other way, unlit and below the wall, is unmistakably not one of them and reads as floating over the lot
  without ever being the brightest thing on screen.
- **A site's squareness does not survive being repeated.** Sanctum copied the site's hard corner outright and it
  was wrong for the same reason it is right over there: a landing page draws about fifteen frames and they are
  large, a workspace draws hundreds and most of them are a 28px row or a 20px chip. At that size a right angle
  stops reading as *carved* and starts reading as a corner that catches the eye every time it passes, and the
  fatigue is cumulative in a way ninety seconds on a page never shows. The radius ramp is the design system's
  own, eased by about a fifth: a rubbed arris, not a pill.
- **A skin cannot only repaint what it owns.** The role tokens came down and the app's own tinted marks did not,
  so the calmest chrome in the product was still carrying a lane of forty saturated category chips down the
  middle of it. Whatever a skin leaves at full chroma becomes, by default, the loudest thing in the room. Two
  things needed naming here (the session card's `.category-tile` and `--color-danger-800`) and both were found
  by *counting* what the chrome actually uses, not by guessing. Note the tile's selector begins with `html`:
  the app's own dark rule is exactly as specific and is declared later in the same layer, so the type selector
  is the cheapest legal way to outrank it.

## How it works

One attribute on `<html>`: `data-skin="sanctum"`. Every rule in the skin's stylesheet is scoped
to it, so an app with no skin selected is not a skin turned down: it is the skin's rules never matching. `none`
writes no attribute at all.

**Two routes are outside all of this, on purpose.** `/login` and `/setup` are built out of the marketing site's
own material — see [`../styles/entry.css`](../styles/entry.css) — because a visitor meets them within a minute
of leaving intentic.dev and has picked no skin yet. That sheet is imported **after** the skin in
`styles.css`: a skin's rules are `[data-skin=…] .p-button…` (an attribute plus a class), which weighs exactly
what `.entry .p-button…` weighs, so source order is what settles the tie — the same argument that puts the
skin after the design system, one step further along. The one thing specificity cannot settle is the
route-element backdrop above, which the skin excludes by name.

Each stylesheet overrides three tiers and then names a handful of components:

| Tier                  | What it repaints                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `--color-surface-*`   | Every Tailwind `surface-*` utility **and** every PrimeVue component (theme.ts bridges them)  |
| `--role-*`            | `bg-card`, `border-line`, `text-muted` and their thousand call sites                         |
| `--radius-*`          | Every `rounded-*` utility: this is what makes a rounded app angular, or a hard one gentle   |

Only after those does a skin name individual selectors, and only ever to change **paint**: colour, border,
shadow, background, outline. Never a width, a padding or a position: a skin that moves things is a skin that
breaks screens it has never been looked at on. That is also why the skin doesn't touch the **body** face: heading
faces are paint, but the reading face sets the metrics of every truncated label in the app, which is geometry.

Component rules sit in `@layer components`, one layer below Tailwind's utilities on purpose: a caller who wrote
`bg-warning/10` on a card still wins, exactly as they do without the skin. The one deliberate exception in the
file is the section-label rule, which is unlayered because the treatment it restates is spelled out by utilities.

The attribute lives on the `<html>` of every window the app runs in, and each window sets its own: a floating
panel is a real window booting its own copy of the app ([`composables/floating.ts`](../composables/floating.ts)),
so it reads the stored skin at load exactly as the first window does. This used to be a hazard worth a paragraph:
a floating panel's DOM was teleported in from another window, whose realm mirrored a fixed list of root
attributes onto it, and `data-skin` was missing from that list for as long as skins existed, so a floating chat
rendered in the app's default look with every stylesheet present and every rule inert. There is no list to keep
in step now.

The skin implies a dark scheme (PrimeVue keys its own dark preset off `data-mode`), so `useSkin` flips the scheme
when a skin goes on. The skin's display webfont is fetched only while that skin is active, and the `<link>` is
re-pointed rather than stacked when the skin changes. Sanctum asks for the site's two: Baloo 2
for every heading and label in the chrome, Playfair Display for the one heading in the app drawn at display size
(`h1.text-4xl`, the sign-in line): the site's own size band, where a serif with hairlines still has hairlines.

## Removing skins entirely

Delete this directory, then remove three one-line call sites:

1. `web/src/styles.css`: the `@import "./skins/…"` line
2. `web/src/pages/settings/SettingsAppearance.vue`: the `useSkin` import and the `── SKINS ──` block. The Theme
   row then wants its two-option control back: `themeOptions` loses the `sanctum` entry and becomes
   the plain light/dark pair bound to `:model-value="scheme"` / `@update:model-value="setScheme"`, and the row's
   icon goes back to ``scheme === `dark` ? `moon` : `sun` ``
3. `web/index.html`: the `ui-skin` clause in the anti-flash script

The tests travel with this directory; nothing outside it references a skin, and no design-system file is touched
by the feature at all. A workspace someone had left on a skin comes back on the app's own dark scheme, because
that is what selecting the skin set: the leftover `ui-skin` key in their browser storage is then read by nothing.

## Adding another skin

Add `<name>.css` beside the one here, scoped to `[data-skin="<name>"]`; add the value to `Skin` in `useSkin.ts`; add an
option to `themeOptions` and an icon to `THEME_ICON` in the appearance page; add the `@import` to `styles.css` and
the name to the anti-flash list in `index.html`. If it wants a face of its own, `FONT_HREF` in `useSkin.ts` is
where that lives.

Three selectors are worth copying rather than re-deriving, because each was a bug first:

- a grouped-list slab is `section > .bg-card.divide-y`, **not** `section > .bg-card`: the workspace's file-tab
  strip is also a card-painted direct child of a `<section>`, and it wore a full panel frame across a bar of tabs;
- the route element is `#app > :first-child:not(.entry)`, **not** `#app > *`: `#app` also holds a screen-reader
  live region and a fixed toast layer, and a backdrop painted on the toast layer floats above the whole app.
  The `:not(.entry)` is the two entry screens opting out — `/login` and `/setup` are dressed as the marketing
  site the visitor just came from (`styles/entry.css`), and they carry the site's own carved plate, so a skin's
  horizon under it is a second temple standing behind the first. It has to be written **here**, because the
  backdrop is drawn with an id and no amount of class specificity in that sheet could reach it;
- a button-tier rule must exclude `.p-button-danger`, `.p-button-warn` and `.p-button-success` explicitly, or a
  `components`-layer tone silently repaints the destructive button in the skin's own metal.

Two hooks the app maintains **for** the skins, and both were bugs first:

- `.session-card` is the fleet board's card, the workflow row and every chat-rail row — one component in three
  frames. A skin restyles it through the variables it declares (`--card-border`, `--card-fill`, `--card-ring`,
  `--card-lift`, and the two the skin owns outright, `--card-ledge` and `--card-drop`); writing a flat
  `box-shadow` on it wipes the attention bar and the selection ring with it. This replaced matching on whichever
  utilities the board card happened to write, which reached the two board cards and left every rail row in raw
  accent beside them.
- `.field-bare` marks a field whose frame belongs to the box **around** it — the chat composer's textarea inside
  its rounded form, the command palette's input inside its search band, and `<CodeField>`'s textarea, which is a
  transparent sheet stacked over a coloured `<pre>` and has no frame it could carry. The field rules must
  exclude it, base and focus both: cutting a recess into one puts a square-cornered slot, and on focus a
  square-cornered halo, inside a rounded box.
