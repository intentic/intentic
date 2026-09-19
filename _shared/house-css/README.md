# @intentic/house-css

The metals the company's surfaces are cut from, stated once: engraved gold, the cartouche frame kit and the
three ember glows. One stylesheet, no selectors, nothing but `--house-*` custom properties on `:root`.

## Who paints these

| consumer                                | what it is                                                    |
| --------------------------------------- | ------------------------------------------------------------- |
| `_site/site/src/styles/global.css`      | the marketing site, where this vocabulary was designed         |
| `_shared/entry-css/entry.css`           | the entry skin: `/login`, `/setup` and the launcher window      |
| `_editor/web/src/skins/sanctum.css`     | the Sanctum skin — the whole app wearing the same design system |

All three carried their own copy until this package existed. The bronze plaque was written out three times,
the cartouche frame kit twice; 2.4 KB of inline SVG alone sat in triplicate, and `entry.css`'s header said
the quiet part out loud — _"when a recipe moves there it moves here."_ It moved here instead.

## Gold actions

The `--house-bronze-*` properties define a warm amber-gold face with fine grain and directional light.
Its frame carries two inset rails, interrupted by diamond engravings in opposite corners. All three
consumers use that frame; the app scales its cuts and engraving down for compact controls.

A reflection crosses the face once on hover or keyboard focus. There is no idle animation. Pressing
recesses the edge, reduced motion removes the sweep, and focus uses a dark inset ring that cannot be
clipped away. Disabled controls return to a neutral surface; loading retains the gold and its geometry.
The light site and entry screens deepen only the gold body, keeping the shared engraving and highlights.

## The rules

**Material, not composition.** A property in `house.css` answers _what is this object made of_. Where it
sits, how big it is and what it is a button for belong to the call site — that is the thing the three
consumers legitimately differ on, and the reason this is a property sheet rather than a component sheet.

**Literal values only.** Nothing here reads a `var()` from either app. The app's tokens follow the accent a
user picked in their workspace; these are the house's own fixed colours, and a plaque that changed metal with
a setting would stop being the house's plaque. Mix them with your own tokens at the call site if you want to.

**Consumed by relative path.** `@import "../../../_shared/house-css/house.css";` — the repo's convention for
cross-package CSS, the same way `_editor/web/src/styles.css` reaches `_editor/ui`'s sheets. The `workspace:*`
dependency in each consumer's `package.json` is what states the edge; the stylesheet resolver walks the path.

## What cannot live here

The cartouche's octagonal `clip-path`, which all three consumers still spell out in full. Its polygon reads
`var(--cut)`, and a custom property's `var()` references resolve on the element that **declares** the
property — so a `--house-octagon` on `:root` would resolve `--cut` against `:root`, where it does not exist,
and every button would come out unclipped. Eight points of geometry, three times, for that reason and no
other.
