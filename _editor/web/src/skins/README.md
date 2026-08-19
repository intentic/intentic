# Skins

A **skin** is a whole-interface look, as opposed to a colour. The accent picker and the light/dark switch both
answer *what colour is this app*; a skin answers *what is this app made of* — what a surface is, what an edge is,
what light does when you touch something.

There is one skin today: **HUD**, a heads-up display. Deep cool glass over a survey grid, hairlines that glow,
corner brackets instead of soft rounding, angular geometry, and a display face on headings. It follows the accent
the user picked — the ground stays cool blue-teal because that is what keeps white text legible at this depth, but
every glow, edge and focus ring is mixed from `--color-primary-*`. Lagoon gives cyan; Ember gives the same
instrument panel lit amber.

## How it works

One attribute on `<html>`: `data-skin="hud"`. Every rule in `hud.css` is scoped to it, so an app with no skin
selected is not the skin turned down — it is the skin's rules never matching. `none` writes no attribute at all.

The stylesheet overrides three tiers and then names a handful of components:

| Tier                  | What it repaints                                                                        |
| --------------------- | --------------------------------------------------------------------------------------- |
| `--color-surface-*`   | Every Tailwind `surface-*` utility **and** every PrimeVue component (theme.ts bridges them) |
| `--role-*`            | `bg-card`, `border-line`, `text-muted` and their thousand call sites                     |
| `--radius-*`          | Every `rounded-*` utility — this is what makes a rounded app angular                     |

Only after those does it name individual selectors, and only ever to change **paint**: colour, border, shadow,
background. Never a width, a padding or a position. A skin that moves things breaks screens nobody looked at.

Component rules sit in `@layer components`, one layer below Tailwind's utilities on purpose — a caller who wrote
`bg-warning/10` on a card still wins, exactly as they do without the skin.

The HUD implies a dark scheme (PrimeVue keys its own dark preset off `data-mode`), so `useSkin` flips the scheme
when the skin goes on. The display webfont is fetched only while a skin is active.

## Removing skins entirely

Delete this directory, then remove four one-line call sites:

1. `web/src/styles.css` — the `@import "./skins/hud.css";` line
2. `web/src/pages/settings/SettingsAppearance.vue` — the `useSkin` import and the `── SKINS ──` block. The Theme
   row then wants its two-option control back: `themeOptions` loses the `hud` entry and becomes the plain
   light/dark pair bound to `:model-value="scheme"` / `@update:model-value="setScheme"`, and the row's icon goes
   back to `scheme === \`dark\` ? \`moon\` : \`sun\``
3. `web/index.html` — the `ui-skin` clause in the anti-flash script

The tests travel with this directory; nothing outside it references a skin, and no design-system file is touched
by the feature at all. A workspace someone had left on the HUD comes back on the app's own dark scheme, because
that is what selecting the skin set — the leftover `ui-skin` key in their browser storage is then read by nothing.

## Adding another skin

Add `<name>.css` beside `hud.css`, scoped to `[data-skin="<name>"]`; add the value to `Skin` in `useSkin.ts`; add
an option to `themeOptions` in the appearance page; add the `@import` to `styles.css`. If it needs its own
webfont, `applyFont` is where that decision lives.
