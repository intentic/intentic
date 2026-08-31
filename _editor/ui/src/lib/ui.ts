import { twMerge } from "tailwind-merge";

/* Centralized class-string builders, the single source of truth for repeated visual recipes.
 * Each function returns a merged Tailwind class string; callers pass overrides that twMerge
 * resolves (e.g. `ui.input('text-2xs px-2 py-1')` shrinks the base input). No @apply, no
 * specificity issues, no !important, the caller always wins. */

/* THE ACTION BUTTON IS `<Button>`, IN FOUR TIERS AND TWO SIZES. Nothing else. The tiers are RANKS, so a screen
 * reads top-to-bottom by weight, and the whole set is spelled in primeng.css:
 *
 *   • LOUD, `class="ui-button-loud"`, the accent as a solid fill. THE MONEY TIER: the control that opens, fixes
 *     or manages the paid relationship — join, update a declined card, manage the subscription, approve a run
 *     that spends credits — and the only button in the app that shouts. At most one per page, or it is not
 *     loud, it is just orange. (Not "asks for money" narrowly: a member's one door to their own subscription is
 *     the same event to the reader, and on that page it is the only action there is.)
 *   • ACCENT, plain `<Button>`, the accent tinted. The action that COMMITS: New agent, Land now, Create.
 *   • BORING, `severity="secondary"`, a neutral fill of the same shape. Everything standing beside an accent.
 *     Same silhouette, different tone, which is the difference a reader can take in without stopping.
 *   • QUIET, `:text="true"`, no chrome at all. Cancel, Dismiss, an inline escape hatch.
 *
 * `danger` / `warn` / `success` are TONES, not tiers: they say what kind of thing a press does and can wear any
 * of the ranks above. `severity="warning"` is not one of them. PrimeVue 4 emits `warn`, and the one call site
 * that spelled it the old way was painted in the brand colour for exactly as long as nobody measured it.
 *
 * TWO THINGS ARE RETIRED, and both grew back once already:
 *
 *   • `outlined`, which was the boring button's SECOND spelling: 30 call sites of transparent-and-hard-bordered
 *     against the neutral fill's own, chosen by which file you were in rather than by what the button did. The
 *     settings pages were outlined throughout and the sandbox pages filled throughout, and the two tone-less
 *     ones ("New extension", "See what changed…") came out wearing a full-strength accent border, so the same
 *     "make me one of these" button shouted on one tab and murmured on the next.
 *   • HAND-WRITTEN GEOMETRY, `px-2.5 py-1 text-2xs` and its five near-variants, at 23 call sites plus two more
 *     hidden in local `const INLINE` / `const ACTION` strings. They existed because `small` used to be Aura's
 *     own 14px/30px control and every dense surface in the app wanted something tighter; `size="small"` IS that
 *     tighter button now (theme.ts), so a call site has nothing left to shrink. Layout is still the caller's,
 *     `shrink-0`, `w-full`, `self-start`, and the one real exception is the mobile upload FAB, a 56px circle.
 *
 * An icon goes in the DEFAULT slot beside the label (`<Icon name="plus" />New agent`), not in `#icon`, whenever
 * the label is slotted too: PrimeVue's default slot replaces the button's entire body, so an `#icon` alongside
 * it renders nothing. `#icon` is right only with the `label` prop. And it needs no size or margin of its own,
 * Iconify draws at 1em and the size carries the gap.
 *
 * THERE IS NO `button*` RECIPE HERE, and its absence is the point.
 *
 * There used to be four, buttonPrimary/Success/Warning/Danger, painting a tinted fill on a bare <button>.
 * They existed because `@layer components` in primeng.css translated only ONE of PrimeVue's severities into
 * this app's tinted language, leaving success/warn/danger as Aura's solid fills; with no way to write a tinted
 * destructive button as a <Button>, the recipes were written here instead. The result was two action buttons
 * that looked alike, sized differently (text-xs at py-1 here, text-sm at py-1.5 there) and were chosen between
 * arbitrarily: 201 <Button> against 31 of these, sometimes both in one header.
 *
 * primeng.css now tints every solid severity, so `<Button severity="danger">` IS what buttonDanger drew. One
 * action button: <Button>, with `severity` for tone and `class` for geometry.
 *
 * ── SIZE IS THE SURFACE'S ANSWER, NOT THE CALL SITE'S ────────────────────────────────────────────────────────
 *
 * There are two, and which one a button takes is decided by WHERE IT IS, not by how important it feels:
 *
 *   • `size="small"` — the compact 26px control, and the app's default. Anything on a dense surface: a row's
 *     trailing cluster, a card's action strip, a toolbar, a section header, a panel, a chat notice. Nearly
 *     three quarters of the buttons in the product are here, and that is the correct proportion.
 *   • no `size` — the 38px control, for a button standing on its own in a PAGE or a DIALOG: a form's submit, a
 *     modal's footer, an empty state's one call to action, a settings card's primary. Room around it is what
 *     makes it the default size rather than a large one.
 *
 * `check:buttons` enforces the two halves of that a machine can actually see — a button in a row's own control
 * cluster is `small`, and DIRECT SIBLINGS AGREE — and nothing subtler, because the version of this rule that
 * asks a reader to judge "is this dense?" is the version that drifted: <RowGroup>'s density taxonomy is the
 * same lesson one control over, and the note at the top of _tools/scripts/row-tiers.mjs is what it cost.
 *
 * A COMPONENT THAT IS ALWAYS PUT ON A CARD IS ON A CARD, and no check can see that — <HostRecreate> draws the
 * sandbox's update/rollback button and its own template has no surface in it, so its size is a judgement its
 * author has to make about every place it is mounted. It was the default for a while, next to a card full of
 * compact controls, and read as one button that had been left big. If a component's whole job is to be dropped
 * into a card, its controls are the card's.
 *
 * ── AND THE FOUR THINGS THAT ARE NOT THE ACTION BUTTON ────────────────────────────────────────────────────────
 *
 * Each is a different KIND of control rather than a tone of one, and each is here because leaving it unnamed is
 * what made people reach for Tailwind:
 *
 *   • `ui.iconButton()` — a bare glyph affordance, no chrome until hover, thumb target baked in.
 *   • `ui.linkButton()` — an inline text action that will NAVIGATE. Link-toned, underlines on hover.
 *   • `ui.textAction()` — the same control in the quiet tone, for a verb that acts in place. No underline.
 *   • `.ui-chip` / `.ui-chip-on` (styles/utilities.css) — a pill that carries a STATE. A filter, a lane, a
 *     mode. Not a button, because a button's tiers are ranks and a set of chips are equals.
 *   • `ui.overlayChip()` — a labelled affordance that floats ON content it must not cover: the Copy chip in a
 *     code block's corner. Its size is set by the CONTENT's box, not by the button scale.
 *
 * Between them and <Button> there is nothing left for a bare `<button class="…">` to be, which is the point:
 * a hand-styled control is invisible to the SKINS (skins/README.md), so it is not merely inconsistent, it is
 * permanently inconsistent — the same word rendering as a pale stone plaque in one row and a dark box in the
 * next, for as long as it stays hand-written. */

/* Bare 24px icon button, the toolbar affordance that shows no chrome until the pointer is on it. Nine of
 * these had been spelled out by hand across the terminal panel, the workspace toolbar, the history panel and
 * the two popover triggers; they agreed exactly, which is what made a tenth so easy to get slightly wrong.
 * Callers size and re-tint through twMerge (`ui.iconButton('h-7 w-7 hover:text-danger')`).
 *
 * `touch-target` is baked in, not left to the caller. 24px of ink is right for a mouse and unreachable with a
 * thumb, and the utility (styles/utilities.css) fixes exactly that split: on a coarse pointer the HIT AREA
 * grows to 44px while the drawn box stays 24, so every toolbar this recipe already serves becomes usable on a
 * phone without one row changing height on a desktop. Baked in because the alternative is remembering it at
 * ninety-odd call sites, which is the same bet this recipe exists to stop taking.
 *
 * SO IS THE DISABLED STATE, and for the same bet. A control with no chrome at rest cannot say "unavailable"
 * with a fill, so it says it the only way it can: the glyph steps down a tone and the hover stops answering.
 * `OFF` below is that decision, shared with the two text recipes, and it is what the call sites' four different
 * `disabled:opacity-*` fades were each approximating on their own. */
const OFF = `disabled:cursor-default disabled:text-subtle disabled:hover:text-subtle`;

const iconButton = (...twClasses: string[]) =>
    twMerge(
        `touch-target flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content`,
        `${OFF} disabled:hover:bg-transparent`,
        ...twClasses,
    );

/* Inline text button that reads as a LINK: "open the docs", "use my own X instead", a lane switch, an escape
 * hatch. Link-toned and underlines on hover, because that is the promise a link makes. Sized so a thumb can hit
 * it (36px) while the negative margin keeps that height from showing up as a gap in the card it sits in, so the
 * same recipe is right on a phone and on a desktop.
 *
 * ITS TONE IS NO LONGER A THING TO OVERRIDE. This used to say "callers restyle the text
 * (`ui.linkButton('text-muted underline hover:text-content')` for the quieter, secondary ones)", and that
 * sentence is what produced `textAction` below: forty-odd call sites each re-deriving the same quiet variant,
 * arriving at `text-muted`/`text-subtle`, with and without `underline`, with and without `transition-colors`.
 * An override that most call sites need is not an override, it is a second recipe that has not been written
 * down yet.
 *
 * The gap is baked in so an icon beside the word needs nothing: Iconify draws at 1em, so `<Icon/>Open` is the
 * whole call. It was the single most-added class here.
 *
 * `w-fit` AND NOT `self-start`, which is what it used to be. Both stop the link stretching across the COLUMN
 * it usually sits in, that is the only job either of them had, but `self-start` does it by overriding the
 * parent's cross-axis alignment, which in a ROW is not stretching that it prevents, it is centring. Every
 * toolbar and dialog footer that puts a Cancel beside a real Button was drawing it a few pixels high (36px of
 * tap target, aligned to the top of a shorter row), and no call site could see why: the cause was a class none
 * of them wrote. A definite width shrink-wraps the box in either direction and leaves `items-center` alone. */
const linkButton = (...twClasses: string[]) =>
    twMerge(
        `-my-1.5 flex min-h-9 w-fit cursor-pointer items-center gap-1.5 text-left text-xs text-link transition-colors hover:underline`,
        `${OFF} disabled:hover:no-underline`,
        ...twClasses,
    );

/* THE SAME CONTROL, IN THE QUIET TONE — "show the command", "hide these", "back to the shared workspace", the
 * little muted verb that sits under a card or at the end of a row. It is `linkButton`'s geometry exactly (one
 * decision about how big an inline text action is, taken once), and differs in the only thing it should: it is
 * `muted` going to `content` instead of link-coloured, and it does NOT underline, because it is not a link and
 * underlining it says it will navigate.
 *
 * IT IS A SEPARATE RECIPE RATHER THAN AN ARGUMENT because the two are chosen by MEANING, not by taste, and a
 * name is the only thing that can carry that. The sweep that produced it found ~45 of these written by hand
 * against ~48 real links, so the quiet one was never the exception it had been documented as. Every failure it
 * removes is a small one and there were a lot of them: eight of the hand-written copies had no `transition`, so
 * their colour snapped where their neighbours faded; six had no minimum height, which is a 16px tap target on a
 * phone; and four underlined on hover while sitting two inches from one that did not. */
const textAction = (...twClasses: string[]) =>
    twMerge(
        `-my-1.5 flex min-h-9 w-fit cursor-pointer items-center gap-1.5 text-left text-xs text-muted transition-colors hover:text-content`,
        OFF,
        ...twClasses,
    );

/* Standard form input (text, password, number, datetime-local, textarea).
 *
 * `ui-off` carries the disabled state, and it is baked in here for the same reason `touch-target` is baked into
 * `iconButton`: it is owed by every one of these and remembering it is not a thing ninety call sites do. A
 * field is one of the controls the design system does not repaint when it goes unavailable — there is no plate
 * to swap, the box IS the plate — so it dims, at the one opacity the app has (styles/utilities.css). */
const input = (...twClasses: string[]) =>
    twMerge(
        `ui-off rounded-md border border-line bg-canvas px-3 py-2 text-sm text-content`,
        `placeholder:text-subtle hover:border-line-strong focus:border-line-strong focus:outline-none`,
        ...twClasses,
    );

/* THE ALERT RECIPES USED TO LIVE HERE, and that is why the app had two red boxes. <Notice> was built out of
 * them, so a notice and a hand-rolled `ui.alertDanger()` div were the same tint, the same border and the same
 * padding, differing only in the warning icon, the ARIA role and the dismiss affordance, none of which the
 * hand-rolled one had. Thirty-two views kept reaching for the recipe because their message was MARKUP and the
 * notice model only held strings; <Notice> takes a slot now, so there is nothing left the recipe could say that
 * the component cannot. They moved into notice.ts, which is the only thing that still needs them. */

/** Dashed-border "nothing here yet" empty state placeholder. */
const emptyState = (...twClasses: string[]) =>
    twMerge(`rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted`, ...twClasses);

/* The CLICKABLE dashed affordance, "add one", "show the rest", "back to the default". `emptyState` above is
 * the passive half of the same visual idea (a dashed outline says "a thing could be here"), and having only
 * that half is why this one got spelled out by hand six times, at three different radii and two text sizes,
 * in the fleet board, the chat rail, the icon rail, the terminal panel twice and the automations view.
 *
 * IT CARRIES THE HOVER, which is the part that makes it read as a control rather than as a placeholder: the
 * dash firms up and the text comes forward together. Geometry is the caller's, a rail tile is a square, a
 * lane's tail is a full-width row, a colour swatch is a circle, so only the radius has a default here, and
 * twMerge lets `ui.addTile('h-7 w-7 rounded-full')` replace it. */
const addTile = (...twClasses: string[]) =>
    twMerge(
        `ui-off inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-line`,
        `text-xs text-muted transition-colors hover:border-line-strong hover:text-content`,
        ...twClasses,
    );

/* A LABELLED AFFORDANCE THAT FLOATS ON CONTENT, and the one control in the app whose height is dictated by
 * something other than the button scale. The Copy chip in a code block's top-right corner is the whole case:
 * a one-line command's block is 34px tall, and the compact action button is 26px of it — a control wearing
 * the block like a coat, with 4px of air under it. It has to be small the way a scrollbar has to be thin.
 *
 * SO IT IS NOT A <Button>, deliberately, and it costs nothing that a Button was buying. The tiers are RANKS —
 * "this is the commit, that is the escape" — and an overlay is not competing for rank with anything; it is
 * the only control on the surface it sits on. What the tiers do own, and what this must not restate, is the
 * geometry of a control in a ROW, which this never is.
 *
 * Chrome at rest, unlike `iconButton`: the affordance sits on top of text, where "no border until you hover"
 * means the reader has to already know it is there. The caller brings the fill (`bg-canvas` on a code block),
 * because what it must be opaque against is the caller's surface, not this recipe's guess at one. */
const overlayChip = (...twClasses: string[]) =>
    twMerge(
        `touch-target inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-0.5`,
        `text-2xs text-muted transition-colors hover:border-line-strong hover:text-content`,
        OFF,
        ...twClasses,
    );

/** Uppercase section heading label (e.g. "CONNECTIONS", "YOUR APPS"). */
const sectionLabel = (...twClasses: string[]) => twMerge(`text-xs font-semibold uppercase tracking-wide text-subtle`, ...twClasses);

export const ui = {
    iconButton,
    linkButton,
    textAction,
    input,
    emptyState,
    addTile,
    overlayChip,
    sectionLabel,
};
