# Skins

A **skin** is a whole-interface look, as opposed to a colour. The accent picker and the light/dark switch both
answer *what colour is this app*; a skin answers *what is this app made of* — what a surface is, what an edge is,
what light does when you touch something.

There are two, and they are deliberately opposite materials:

- **HUD** (`hud.css`) — a heads-up display. Deep cool glass over a survey grid, hairlines that glow, corner
  brackets instead of soft rounding, angular geometry, and an angular technical face on headings.
- **Sanctum** (`sanctum.css`) — **the site's design system, worn by the app**. Same metals, same ink, same
  materials, same ornament kit as `_site/site/src/styles/global.css`: a near-colourless warm ash ground with a
  tooth in it, one gold rule round everything, cream ink, and the site's two faces. The rail and every overlay
  are faced in the site's woven cloth; the one loud button is a panel of dark timber; nothing else is either. A
  distant temple stands on the floor of the window where the app has put nothing in front of it.

**They part company on the accent, and that is the interesting difference.** The HUD is *lit* by the colour the
user picked: every glow, edge and focus ring is mixed from `--color-primary-*`, so Lagoon gives it cyan and Ember
gives the same instrument panel amber. Sanctum's structure is **fixed gold** (`#c9a05c`, the site's own) whatever
the picker says, and spends the accent only where it means something: a link, a focus ring, a ticked box, the
light in the timber button. That is not a smaller idea, it is the site's own rule — *structure is gold, the ember
is spent, never spread* — and it is what stopped the skin reading as one warm smear. A skin that lets the accent
paint its hairlines has a thousand of them to paint.

## The rule both of them keep

**Every surface a word sits on is flat in the low frequencies, and opaque.** Overlays that cover live text are
solid, never translucent, and no plate ever carries a *gradient*. A wash down the top of a card puts the first
line of a paragraph on a different ground from the last — nothing is unreadable and everything is slightly worse,
which is the expensive kind of wrong because it never announces itself.

A *texture* is not that. A fine, high-frequency speckle has no low-frequency component at all: every square inch
of it averages the same value, so the contrast at the top of a paragraph and at the bottom are the same number.
Sanctum read the rule as "no background-image on a plate" for one cut, and shipped a skin built out of materials
in which every surface anyone actually looked at was a flat rectangle. The plates carry a tooth now, measured at
under a hundredth of a contrast ratio point.

Sanctum has paid for that rule and five others, and the notes are kept at the top of the file:

- **Ornament on an edge becomes noise at UI size.** A carved arcade that reads as stone at 40px reads as a torn,
  dithered edge at 14px — and every panel in an app is a 14px edge. Character has to come from the material, the
  line weights and the type, because those survive being shrunk. The site's turned corner is therefore drawn in
  exactly one place: the dialog, which is the only panel big enough to carry it.
- **A decorative layer that scales with the viewport will eventually fill the screen.** The temple was sized as a
  share of window width; at 1900px it became a lit mountain range across the bottom third. It is capped in
  absolute pixels now.
- **A brown ground makes gold invisible.** The cut before this one ran the stone ramp at three times the chroma,
  at a redder hue, and drew every rule in the accent — so the wall, the plates and the lines were all the same
  warm thing and none of them could be the brightest. The ground lost its colour and the metal kept it.
- **The app's accent tier is six warm chips on a settings page.** `<Button>` tints itself from the picked colour,
  and a screen carries half a dozen: Change, Save, Open, New workflow, Land now. In this skin that tier is a gold
  cartouche with a cream label — the site's `.btn` — and the timber `ui-button-loud` is the only lit control
  left. The severities (`danger`, `warn`, `success`) keep their own tones, and have to be excluded **by name**:
  the app sets each one's tone in `@layer primeng`, and a skin's `components` layer beats that layer outright.
- **A site's squareness does not survive being repeated.** Sanctum copied the site's hard corner outright and it
  was wrong for the same reason it is right over there: a landing page draws about fifteen frames and they are
  large, a workspace draws hundreds and most of them are a 28px row or a 20px chip. At that size a right angle
  stops reading as *carved* and starts reading as a corner that catches the eye every time it passes, and the
  fatigue is cumulative in a way ninety seconds on a page never shows. The radius ramp is the design system's
  own, eased by about a fifth — a rubbed arris, not a pill.
- **A skin cannot only repaint what it owns.** The role tokens came down and the app's own tinted marks did not,
  so the calmest chrome in the product was still carrying a lane of forty saturated category chips down the
  middle of it. Whatever a skin leaves at full chroma becomes, by default, the loudest thing in the room. Two
  things needed naming here — the session card's `.category-tile` and `--color-danger-800` — and both were found
  by *counting* what the chrome actually uses, not by guessing. Note the tile's selector begins with `html`:
  the app's own dark rule is exactly as specific and is declared later in the same layer, so the type selector
  is the cheapest legal way to outrank it.

## How it works

One attribute on `<html>`: `data-skin="hud"` or `data-skin="sanctum"`. Every rule in a skin's stylesheet is scoped
to it, so an app with no skin selected is not a skin turned down — it is the skin's rules never matching. `none`
writes no attribute at all.

Each stylesheet overrides three tiers and then names a handful of components:

| Tier                  | What it repaints                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `--color-surface-*`   | Every Tailwind `surface-*` utility **and** every PrimeVue component (theme.ts bridges them)  |
| `--role-*`            | `bg-card`, `border-line`, `text-muted` and their thousand call sites                         |
| `--radius-*`          | Every `rounded-*` utility — this is what makes a rounded app angular, or a hard one gentle   |

Only after those does a skin name individual selectors, and only ever to change **paint**: colour, border,
shadow, background, outline. Never a width, a padding or a position — a skin that moves things is a skin that
breaks screens it has never been looked at on. That is also why neither skin touches the **body** face: heading
faces are paint, but the reading face sets the metrics of every truncated label in the app, which is geometry.

Component rules sit in `@layer components`, one layer below Tailwind's utilities on purpose — a caller who wrote
`bg-warning/10` on a card still wins, exactly as they do without the skin. The one deliberate exception in each
file is the section-label rule, which is unlayered because the treatment it restates is spelled out by utilities.

Both skins imply a dark scheme (PrimeVue keys its own dark preset off `data-mode`), so `useSkin` flips the scheme
when a skin goes on. Each skin's display webfont is fetched only while that skin is active, and switching between
them re-points the single `<link>` rather than stacking a second one. Sanctum asks for the site's two: Baloo 2
for every heading and label in the chrome, Playfair Display for the one heading in the app drawn at display size
(`h1.text-4xl`, the sign-in line) — the site's own size band, where a serif with hairlines still has hairlines.

## Removing skins entirely

Delete this directory, then remove three one-line call sites:

1. `web/src/styles.css` — the two `@import "./skins/…"` lines
2. `web/src/pages/settings/SettingsAppearance.vue` — the `useSkin` import and the `── SKINS ──` block. The Theme
   row then wants its two-option control back: `themeOptions` loses the `hud` and `sanctum` entries and becomes
   the plain light/dark pair bound to `:model-value="scheme"` / `@update:model-value="setScheme"`, and the row's
   icon goes back to ``scheme === `dark` ? `moon` : `sun` ``
3. `web/index.html` — the `ui-skin` clause in the anti-flash script

The tests travel with this directory; nothing outside it references a skin, and no design-system file is touched
by the feature at all. A workspace someone had left on a skin comes back on the app's own dark scheme, because
that is what selecting the skin set — the leftover `ui-skin` key in their browser storage is then read by nothing.

## Adding another skin

Add `<name>.css` beside the two, scoped to `[data-skin="<name>"]`; add the value to `Skin` in `useSkin.ts`; add an
option to `themeOptions` and an icon to `THEME_ICON` in the appearance page; add the `@import` to `styles.css` and
the name to the anti-flash list in `index.html`. If it wants a face of its own, `FONT_HREF` in `useSkin.ts` is
where that lives.

Three selectors are worth copying rather than re-deriving, because each was a bug first:

- a grouped-list slab is `section > .bg-card.divide-y`, **not** `section > .bg-card` — the workspace's file-tab
  strip is also a card-painted direct child of a `<section>`, and it wore a full panel frame across a bar of tabs;
- the route element is `#app > :first-child`, **not** `#app > *` — `#app` also holds a screen-reader live region
  and a fixed toast layer, and a backdrop painted on the toast layer floats above the whole app;
- a button-tier rule must exclude `.p-button-danger`, `.p-button-warn` and `.p-button-success` explicitly, or a
  `components`-layer tone silently repaints the destructive button in the skin's own metal.
