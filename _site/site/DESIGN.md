# The intentic.dev design system

The rules and tokens every page of the public site is built from: the app's own look, re-cut for pages that have to make a stranger understand, believe and start within a few screens.

The app is where people work and the site is where they decide. The two share a skin (Sanctum by night; the app's Light scheme as the desk skin by day), a glyph grammar, a gold that means "this one", and the same hover card for detail. The site adds only what the app never needs: a photograph, a display serif, ornament, and figures that move.

The tokens are in [src/styles/system.css](src/styles/system.css) (motion, display steps, rhythm, niches, the lamp, the Tip, figures), with the older materials in [src/styles/global.css](src/styles/global.css). The light skin relights both in [src/styles/desk.css](src/styles/desk.css). Copy budgets are code: [src/lib/design/copy-budgets.ts](src/lib/design/copy-budgets.ts).

## Principles

1. **One question per band.** A band answers one thing a visitor asks (what is it, does it work, what does it cost, can I trust it, how do I start) with one exhibit.
2. **Show, then say.** The exhibit carries the argument: the live app, a screenshot, an animated figure, a number. The words name it and caption it. A band with no exhibit is unfinished. FAQ and legal pages are the only exceptions.
3. **Words on demand.** Visible copy fits its budget. Anything more goes in a **Tip**, which opens under the pointer the way the app's hover cards and (i) hints do. A paragraph on the surface of a selling page is a defect.
4. **Light means "look here".** The ground is dark stone. Gold draws structure and state. Ember is light, and a viewport holds one lit thing at a time.
5. **Motion explains.** Things move to show a process: a wire carrying work, a count arriving, a step lighting. Nothing moves to decorate, and every figure has a still frame that makes sense on its own.
6. **Same eyes as the app.** The gold, the inks, Public Sans, JetBrains Mono, the square-cap glyph grammar, the motion curve and the hover card are the app's own values, not look-alikes.

## Words

Every visible string has a slot, and every slot has a ceiling. Kit components pass each string through `held(slot, text, where)`. A string over its ceiling fails the page's render: the error overlay in `astro dev`, a failed `astro build`. The error names the slot, the count and the way out.

| Slot | Ceiling (aim) | What it is |
| --- | --- | --- |
| eyebrow | 3 (2) | Names the band's subject. Never a sentence. |
| heading | 10 (7) | The band's claim, at most two lines at display size. |
| lede | 20 (14) | One sentence under the heading. |
| title | 4 (3) | A tile's, node's or step's name. |
| line | 12 (8) | The one line under a title. |
| label | 4 (2) | A stat's label, a chip, a node's mono sub-label. |
| action | 4 (2) | A button or a link. Starts with a verb. |
| caption | 14 (10) | The line under an exhibit. |
| tipTitle | 3 (2) | A Tip's heading. Same limit as the app's tooltip title. |
| tipBody | 40 (25) | The detail the surface left out. |
| tipRow | 2 (1) | The label of one of a Tip's label/value rows. |

- If a lede needs "and also", the second half is a Tip.
- Explain a section once, in its (i). The app's rule (ux-redesign §2a) holds here too: a section's how-it-works goes in the (i) at the end of its lede, never in a note repeated beside it.
- Numbers beat adjectives: "5,869 of 6,120 commits", not "most of the code".
- Copy lives in `@intentic/site-content`, never in an `.astro` file.
- Never put the thing a visitor needs in order to decide (a price, a requirement, a limit) only inside a Tip.
- A term counts toward the sentence it sits in. A stat's prefix, suffix and word value (`MIT`, `15+`) are labels.
- A kit component writes no words of its own. The one exception is Stat's connector "of" ("5,869 of 6,120").
- The budget counts words; it cannot tell whether an action starts with a verb. That one is the reviewer's.

## Grounds

The ground is what a band stands on. It is the first thing a visitor sees of each band, so it is chosen, never left to default.

| Ground | What it is | Where it goes |
| --- | --- | --- |
| Plate | The temple photograph under a scrim well (`.plate`, `PageBackdrop`). | A page's first screen and the home pages' closing band. Nowhere else. |
| Wall | An 84px gold hairline grid fading from the top (`.wall`). | The default ground of a band. |
| Lamp | A warm pool of light behind the exhibit (`--role-lamp`). | A band whose exhibit is the point: a figure, a live shot. One per band, never on a band that already has the plate. |
| Plinth | A lit strip with hairlines above and below (`.plinth`). | A row of stats, or one measured figure. |
| Plain | The canvas. | Text-dense bands: FAQ, ledgers, legal. |

- Bands are separated by the gold hairline that fades out at both ends (`.band + .band`). No other divider goes between bands.
- A plinth band is padded by `--plinth-pad`, not `--band-pad`: a strip of stats in a full band's height reads as an empty field. The plinth draws its own hairlines, so no band rule sits above or below it.
- Two bands in a row do not both take the lamp. Down a page, alternate wall and lamp.

## Materials and depth

From back to front: ground, stone, frame, lacquer.

| Material | Recipe | What it holds |
| --- | --- | --- |
| Stone | `--wash-panel` and a 1px `--color-line`, square edges | A tile, a node, a step. |
| Frame | `.frame` or `Window`: a double rule, turned corners, an optional lotus finial | The one exhibit a band is about. |
| Lacquer | The nav panel's: `--role-nav-lacquer`, a gilt top edge, a deep shadow | Anything that floats over the page: the Tip, a menu. |
| Well | `--role-code-fill`, or a niche's well | A command, a niche, an input. |

- **Corners mark the exhibit.** Turned corners and the finial go on the one framed thing in a band: the window, the figure, the recommended plan. Tiles in a grid get none. Corners on every box (the state this system was written against) say nothing about which box matters.
- **A tile is stone; a node is a part of an exhibit.** A tile's edge is `--color-line`. A node in a figure stands on `--role-node-fill` with the stronger `--role-node-line`, because the figure around it is already a frame. A lit node takes a gold rim (`--role-node-rim-lit`) and throws ember light (`--role-node-glow-lit`).
- **No box inside a box.** Inside stone, use type and a hairline, never a second bordered panel. A set of facts is label/value pairs, not chips in cards.
- Edges are square everywhere: the site is carved stone. The only round things are status dots and the controls inside a product mock.
- A pressable tile answers the pointer the way a nav row does: its edge goes from `line` to `line-strong` and its niche lights. A tile in a grid does not lift; lifting is for a window that links.
- A tile with both a link and a Tip: the whole tile is the link, and a tap on it follows the link. Pointing anywhere on the tile opens its Tip. Its (i) is the way in for keyboard and touch. A tile with a Tip and no link still answers the pointer.

## Type

| Step | Face | Token | What it sets |
| --- | --- | --- | --- |
| display-1 | Lora 400 | `--text-display-1` | The hero headline. Home pages only. |
| display-2 | Lora 400 | `--text-display-2` | A band's heading, an inner page's h1. |
| display-3 | Lora 400 | `--text-display-3` | An exhibit's title, a stat's value, a price. |
| title | Baloo 2, the brand face (h3–h6) | `--text-title` | A tile's, node's or step's name. |
| lede | Public Sans, muted | `--text-lede` | The sentence under a heading. |
| note | Public Sans | `--text-note` | A tile's line, a Tip's body, a caption. |
| eyebrow | Public Sans capitals, tracked .22em, gold | `--text-2xs` | The name above a heading. |
| mono | JetBrains Mono | `text-2xs` to `text-sm` | Commands, paths, routes, a figure's annotations. |

- Every page uses one display ink, `--role-display-ink`: ivory by night, the page's ink by day. Before this system, the inner pages used a dimmer bronze than the home page.
- Weights are set per skin in global.css: the dark skin draws one step lighter, as the app does. Never write a numeric weight.
- The ember full stop (`.stop`) belongs only to the hero headline and the closing band.
- A heading's measure is 24ch and a lede's is `--container-copy`. The spacing inside a head (eyebrow to heading to lede to action) belongs to `SectionHead` alone; nothing else sets it.
- A centred eyebrow takes its hairline on both sides.

## Colour

- **Gold** (`--color-gold`, `--color-gold-bright`, `--color-accent`) is structure and state: rules, edges, glyph gilt, eyebrows, links, focus, the picked tab, the rim of a lit node. It is the same gold as the app's Sanctum accent.
- **Ember** (`--color-primary-*`) is light: the bronze of the primary button, the lamp, a lit node, a travelling pulse, the jewel in a glyph, the headline's full stop. A viewport holds one lit thing, and one moving figure. (The kit page breaks this on purpose: it is a specimen sheet.)
- **Ink**: `content` for what is read, `muted` for ledes and notes, `subtle` for captions and annotations. Nothing goes below `subtle`.
- **Status** green, amber and red appear only inside a figure of the product's state, such as a passed run or a failed check. They never decorate.
- **Charts** use `--series-1` to `--series-5` in order, on `--role-track`. A meter is a 4px bar of `--series-1` with square ends, the app's usage meter at site scale. Gold and ember are the brand; verdigris and lapis are the app's Sanctum success and info hues; stone is "the rest".
- A literal colour in a component cannot follow the desk skin. Use a token. If the role you need is missing, add it to system.css and relight it in desk.css.

## Icons

There is one grammar, the app's: a 24-unit grid, square caps, mitred joins, cut corners, stepped lintels, lozenge joints, no circles. Where the app already draws a subject, the site's glyph starts from the app's drawing (`_editor/ui/src/icons/`), so a tile and the product screen it describes show the same picture. Where the app's drawing has a circle (a branch's nodes, the (i)), the site draws an octagon: the circle with its corners cut.

| Rendering | Look | Where |
| --- | --- | --- |
| Gilt in a niche | The nav menu's: an octagonal well, gold-leaf line, a low plane fill, an ember jewel | Any icon that names a subject: a tile, a step, a node, a stat. |
| Line | `1em`, `currentColor`, stroke 2: the app's `Icon` | Inside a button, a chip, a Tip, a caption. |

- The registry is [src/lib/navIcons.ts](src/lib/navIcons.ts), whose glyphs come in four layers (plane, line, spark, jewel). Add a glyph there; never inline a one-off path in a page.
- The line rendering drops the plane, strokes the line and the spark, and fills the jewel, all in `currentColor`. The gilt rendering carries its own gradient, so a glyph draws correctly on a page without the nav.
- An icon carries something the words beside it do not, or it is not drawn. **An icon is never a bullet.** A list's mark is the lozenge (`Point mark="lozenge"`). The lotus is the signature (the wordmark, the finial, the mark over a closing band) and appears at most once per band.
- Brand marks belong to their owners: `PROVIDER_BRAND_PATHS` from `@intentic/constants` and the OS marks in `desktop-downloads.ts`. They are filled in `currentColor` and never redrawn.
- A row of glyphs is all one size.

## Detail on demand: the Tip

The Tip is the site's version of the app's hover card (the `v-tooltip` Tip and `InfoHint`).

- **Triggers.** A *term*: a word in a lede or line with a dotted gold underline. An *(i)* after a section's lede, for the section's how-it-works, once. A *whole tile*, whose Tip holds its detail.
- **Content.** A title of at most 3 words, a body of at most 40, optional label/value rows, and at most one link.
- **Look.** Lacquer, a gilt top edge, a `line-strong` rule, square corners (the cut corners belong to the bar's panel and the buttons), and a lozenge pointing at the trigger. At most `--tip-width` wide. Title in the brand face, semibold; body in `note`, muted; row labels subtle, values in content with tabular figures.
- **Behaviour.**
  - It opens on pointer hover after `--tip-intent` (80ms), and on keyboard focus.
  - It stays open while the pointer travels into it (`--tip-grace`, 150ms), so its link can be pressed. Both timings are their own tokens and are not zeroed under reduced motion: a zero intent would open a card on every pass of the pointer.
  - It closes on leave, on Escape, or when another Tip opens.
  - On touch, a tap opens it, and a second tap or a tap outside closes it. The app suppresses tooltips on touch; the site cannot, because visitors on phones must reach the detail.
  - It sits below its trigger, centred on it, flips above near the foot of the viewport, and keeps 8px from the viewport's edges. The lozenge keeps pointing at the trigger when the card is pushed sideways.
  - A card the pointer opened closes once its trigger scrolls out of view. One held by keyboard focus follows its trigger.
- **In the HTML.** The detail is in the page's markup, so a crawler, the `.md` mirror and a reader without JavaScript still get it.
- **In the top layer.** The card is a `popover` opened by a real button (`popovertarget`), so a band's `overflow: hidden` cannot clip it, and without the script the browser still gives tap to open, Escape, light dismiss and one open at a time.
- **Two traps.** The `.md` mirror drops every `<button>`, so a term's word sits outside its button, with the button laid over it. A tile's (i) comes last in the markup and is drawn top-right, so a screen reader and the mirror read the title first.

## Motion

| Token | Value | For |
| --- | --- | --- |
| `--ease-smooth` | `cubic-bezier(.22, 1, .36, 1)` | Every transition. The app's curve. |
| `--ease-settle` | a small overshoot | A glyph or node settling into place. Never text. |
| `--motion-quick` | 150ms | Hover, press. |
| `--motion-base` | 200ms | A Tip opening, a tab switching. |
| `--motion-reveal` | 600ms | A band arriving (`.fade-in`). |
| `--motion-draw` | 1400ms | A figure's wires drawing themselves. |
| `--motion-count` | 1600ms | A stat counting up. |
| `--motion-cycle` | 7s | One loop of a figure that shows something repeating. |
| `--motion-stagger` | 80ms | Between siblings that arrive together. |
| `--motion-loop` | `running` | A loop's play state; `paused` under reduced motion. |

- A figure starts when a third of it is in view and pauses once it is fully off screen. Nothing animates off screen.
- A figure already on screen when the page loads starts at rest rather than drawing itself in, or it would visibly un-draw first. A stat counts once per page view.
- Animate transform, opacity, `stroke-dashoffset` and colour. Never animate layout.
- Under `prefers-reduced-motion` the durations go to zero and `--motion-loop` to `paused` in system.css, so a component that only reads the tokens shows its end state without knowing the preference exists. A loop stops on a meaningful frame.
- A count-up never moves the layout: tabular numerals and a reserved width.
- Words do not move once they can be read: no parallax on copy, no looping text.

## Figures and diagrams

Every drawn diagram is built from five parts.

| Part | Drawing |
| --- | --- |
| Node | A stone tile: a small niche glyph, a title of at most 4 words, an optional mono label. |
| Wire | 1px `--role-edge`. Dashed means optional or indirect. |
| Lit wire | 1.5px `--role-edge-lit`: something is travelling along it now. |
| Pulse | A lozenge in `--role-pulse` with `--role-pulse-glow`, moving along a lit wire. |
| Precinct | A frame around nodes that belong together, with its name as an eyebrow on its top rule. |

- Direction carries meaning: left to right is time and cause; top to bottom is containment and hierarchy.
- At most seven nodes are in view at once. More than that become a precinct.
- Pointing at a node lights its wires, opens its Tip and pauses the loop. This is the access map's behaviour, generalised.
- A flow turns vertical when its own width is below its nodes' reading width (a container query, not the viewport), so a flow in a half-width card turns before a flow across a band does. A figure that cannot turn is replaced by its still frame, not shrunk.
- The still frame (reduced motion, no script, a screenshot) is every wire drawn and the last node lit: the process, finished.
- A figure inside a link holds no Tips: a tap has to mean one thing. The compact Flow refuses them and keeps its caption for screen readers only.
- Every figure is a `<figure>` with a caption of at most 14 words, and a screen reader reads it as a list of its nodes.
- The temple is the site's only metaphor ([landing-blueprint.md](../../docs/marketing/landing-blueprint.md)). Diagrams are literal.

## Band compositions

A selling page is built from these six compositions and nothing else.

| Composition | Shape | Usual ground |
| --- | --- | --- |
| Stage | The head above, one exhibit at full shell width. | Wall or lamp |
| Split | The head and up to three points on one side (5/12), the exhibit on the other (7/12). Sides alternate down a page. | Wall |
| Grid | The head above, then 3, 4 or 6 tiles. | Wall or plain |
| Strip | 3 or 4 stats in a row. | Plinth |
| Ledger | The head and collapsed rows: an FAQ, a comparison table. | Plain |
| Close | A display-2 heading and one action. | Plate |

- Spacing comes from the tokens: `--band-gap` from head to exhibit, `--band-pad` above and below, and content capped at `--shell-max`.
- A band has at most one primary action (the bronze `btn-primary`). The page's conversion action repeats in the hero, the getting-started band and the close.
- On a phone everything stacks in reading order (head, exhibit, action). Tiles drop to two columns below 64rem and one below 40rem; an odd last tile spans the row. A strip of stats keeps two columns down to the narrowest phone.
- `--shell-max` is a section's outer width, gutters included, and every section of a page uses it, so their edges line up. `PageHero` still uses `max-w-7xl` and is the next thing to move onto it.

## The kit

The components that hold these rules live in `src/components/kit/`. A page reaches for them before it writes its own markup. Each one passes its copy through the budgets and reads only the tokens.

| Component | What it is | What it replaces |
| --- | --- | --- |
| `Band` | A band: its ground, its rhythm, the hairline above it. | `landing/IntroBand.astro`, and hand-made `<section class="band">` blocks with a `.wall`. |
| `SectionHead` | Eyebrow, heading, lede, the (i) Tip, one action. | Band intros, the heading block of `PageHero`, the tour's stage heads. |
| `Glyph` | A registry glyph, gilt in a niche or as a line. | `NavNiche` outside the nav, inline SVG icons, lotus bullets. |
| `Tip` | The hover card. | Paragraphs under cards, small-print notes. |
| `FeatureTile` | Niche, title, line, Tip, link. | `TrustCards`, `Station`, the download page's tiles, `/about/`'s trust cards. |
| `TileGrid` | Lays out tiles (2, 3 or 4 columns) or a strip of stats. | Hand-written grids with their own breakpoints. |
| `Stat` | A number that counts up, its label, an optional meter. | `/about/`'s stat strip, "It builds itself", the pricing figures. |
| `Flow` | Nodes joined by wires, with a pulse travelling through them. | "Three steps", the features index's automation card, setup steps. |

`/kit/` shows every token and component in both skins. It exists only under `astro dev`, so production never builds it: its route's `getStaticPaths` returns no paths in a build.

In use today: `/about/` (its figures strip and its trust tiles) and `/features/` (the Automations card's flow). The home page's `#trust` band still reads the same records' long `body` through `TrustCards`, so `site-content/src/about.ts` holds each trust card twice (`body` and `kit`) until that band moves onto the kit.

## Before a band ships

- [ ] It answers one question, and its exhibit is the answer.
- [ ] Every string fits its budget, and the rest is in a Tip. Every action starts with a verb.
- [ ] Its ground was chosen, and it does not take the lamp if the band before it did.
- [ ] Corners and a finial appear at most once: on the exhibit.
- [ ] No box sits inside a box.
- [ ] Every icon carries meaning, comes from the registry, and is the same size as its row.
- [ ] One lit thing is in view.
- [ ] It moves only to explain, pauses off screen, and has a still frame under reduced motion.
- [ ] It reads in both skins (`?variant=default`, `?variant=desk`), at 1440px and at 390px.

## What this system leaves alone

- **The hero and the nav** (`focused-hero.css`, `Nav.astro`). They are the bar the rest of the site is raised to.
- **The temple metaphor** and the decisions recorded in [landing-blueprint.md](../../docs/marketing/landing-blueprint.md).
- **Docs prose** (`.docs-body`). Reading at length is the docs' job, so the word budgets govern selling pages only. Docs pages still use the kit's figures, Tips and glyphs.
