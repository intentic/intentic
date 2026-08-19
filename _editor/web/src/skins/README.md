# Skins

A **skin** is a whole-interface look, as opposed to a colour. The accent picker and the light/dark switch both
answer *what colour is this app*; a skin answers *what is this app made of* — what a surface is, what an edge is,
what light does when you touch something.

There are two, and they are deliberately opposite materials:

- **HUD** (`hud.css`) — a heads-up display. Deep cool glass over a survey grid, hairlines that glow, corner
  brackets instead of soft rounding, angular geometry, and an angular technical face on headings.
- **Sanctum** (`sanctum.css`) — carved warm stone. A basalt ground with mineral grain in it, panels sunk into that
  stone, gilded ornament running the edge of every one of them, and Roman inscriptional capitals. A temple stands
  on the floor of the window wherever the app has put nothing in front of it.

Both follow the accent the user picked. Each keeps its own ground fixed — cool blue-teal, warm basalt — because
that is what holds the text contrast, but every glow, edge, focus ring and piece of gilding is mixed from
`--color-primary-*`. Lagoon gives the HUD its cyan and the Sanctum jade inlay; Brass gilds the Sanctum properly
and lights the HUD amber.

## How it works

One attribute on `<html>`: `data-skin="hud"` or `data-skin="sanctum"`. Every rule in a skin's stylesheet is scoped
to it, so an app with no skin selected is not a skin turned down — it is the skin's rules never matching. `none`
writes no attribute at all.

Each stylesheet overrides three tiers and then names a handful of components:

| Tier                  | What it repaints                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `--color-surface-*`   | Every Tailwind `surface-*` utility **and** every PrimeVue component (theme.ts bridges them)  |
| `--role-*`            | `bg-card`, `border-line`, `text-muted` and their thousand call sites                         |
| `--radius-*`          | Every `rounded-*` utility — this is what makes a rounded app angular                         |

Only after those does a skin name individual selectors, and only ever to change **paint**: colour, border, shadow,
background, mask. Never a width, a padding or a position. A skin that moves things breaks screens nobody looked at.

Component rules sit in `@layer components`, one layer below Tailwind's utilities on purpose — a caller who wrote
`bg-warning/10` on a card still wins, exactly as they do without the skin. The one deliberate exception in each
file is the section-label rule, which is unlayered because the treatment it restates is spelled out by utilities.

Both skins imply a dark scheme (PrimeVue keys its own dark preset off `data-mode`), so `useSkin` flips the scheme
when a skin goes on. Each skin's display webfont is fetched only while that skin is active, and switching between
them re-points the single `<link>` rather than stacking a second one.

### Ornament, and how it stays accent-coloured

Sanctum draws its carvings as hand-authored SVGs carried inline as data URIs, used as `mask-image` rather than as
pictures. That is the whole trick: an SVG in a `background-image` has its colours baked where it is written and can
never see a custom property, but an SVG in a mask is a *shape*, and the colour showing through it is the
pseudo-element's own background — a gradient mixed from the accent. One set of motifs, thirteen materials.

Two structural properties come with that and are documented at length in the file: the ornament hosts take
`position: relative` (a containing block for the layer) and `isolation: isolate` (a stacking context, without
which `z-index: -1` paints the carving *behind* the panel instead of *into* it). Both are safe here only because
every floating surface in this app is teleported to `<body>` before it is positioned.

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

Two selectors are worth copying rather than re-deriving, because both were bugs first:

- a grouped-list slab is `section > .bg-card.divide-y`, **not** `section > .bg-card` — the workspace's file-tab
  strip is also a card-painted direct child of a `<section>`;
- the route element is `#app > :first-child`, **not** `#app > *` — `#app` also holds a screen-reader live region
  and a fixed toast layer, and a backdrop painted on the toast layer floats above the whole app.
