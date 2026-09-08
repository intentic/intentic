import { twMerge } from "tailwind-merge";

// Centralized Tailwind class-string builders: each returns a merged class string, and callers pass overrides that
// `twMerge` resolves (`ui.input('text-2xs px-2 py-1')` shrinks the base input). No @apply, no specificity fights:
// the caller always wins.

// The action button is <Button>, in four ranked tiers and two sizes (primeng.css); no other `button*` recipe exists.
// - loud (`ui-button-loud`): solid accent fill, the paid-relationship action. At most one per page.
// - accent (plain <Button>): tinted accent, the commit action (New, Create, Land).
// - boring (`severity="secondary"`): neutral fill, accent's silhouette.
// - quiet (`:text="true"`): no chrome (Cancel, Dismiss).
// `danger`/`warn`/`success` are tones layered on any tier, not `severity="warning"` (PrimeVue 4 emits `warn`).
// An icon goes in the default slot beside a slotted label; `#icon` only pairs with the `label` prop.
// Size follows the surface, not importance: `size="small"` (26px) on any dense surface, no `size` (38px) standing alone
// on a page or dialog.
// Not <Button> at all: `ui.iconButton()` (bare glyph), `ui.linkButton()` (navigates), `ui.textAction()` (acts in
// place), `.ui-chip` (state, not rank), `ui.overlayChip()` (floats on content).

// Bare 24px icon button; `touch-target` grows the hit area to 44px on a coarse pointer while the drawn box stays
// 24px. `OFF` is the shared disabled state for chrome-less controls, since there's no fill to dim at rest.
const OFF = `disabled:cursor-default disabled:text-subtle disabled:hover:text-subtle`;

const iconButton = (...twClasses: string[]) =>
    twMerge(
        `touch-target flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content`,
        `${OFF} disabled:hover:bg-transparent`,
        ...twClasses,
    );

// Inline text button reading as a link (underlines on hover); 36px tap target via negative margin. Use
// `textAction` for a quieter tone rather than overriding this one; keep `w-fit`, not `self-start` (which
// centers, not shrink-wraps, in a row).
const linkButton = (...twClasses: string[]) =>
    twMerge(
        `-my-1.5 flex min-h-9 w-fit cursor-pointer items-center gap-1.5 text-left text-xs text-link transition-colors hover:underline`,
        `${OFF} disabled:hover:no-underline`,
        ...twClasses,
    );

// Same geometry as `linkButton`, quiet tone: muted to content, no underline (it doesn't navigate). A separate
// recipe, not an argument, since the two are chosen by meaning, not styling taste.
const textAction = (...twClasses: string[]) =>
    twMerge(
        `-my-1.5 flex min-h-9 w-fit cursor-pointer items-center gap-1.5 text-left text-xs text-muted transition-colors hover:text-content`,
        OFF,
        ...twClasses,
    );

// The text field is `ui-field-box`, in three variants and two sizes; nothing else (docs/input-audit.md).
// - `ui.input()`: the framed field (rim, fill, radius), for a page, dialog, settings card or standalone filter.
// - `ui.inputInline()`: replaces text in place (a title being renamed, a tab, a tree node); no rim, takes the
//   surrounding font, no height change.
// - `.field-bare` (a class, not a recipe): the field whose frame belongs to a parent wrapper (the chat composer, a
//   SearchBar); the wrapper answers `:focus-within` for the whole assembly.
// Size follows the surface, as with the button: `ui.input()` is 38px (page/dialog), `ui.inputSm()` is 26px (dense
// surfaces), matching the button's two heights so a shared form row lines up.
// A call site may pass layout/content classes only (width, flex, margin, `resize-y`, `font-mono`); not padding, text
// size, radius, fill or a focus rule (`check:inputs` enforces this).
// A field's focus ring never paints outside its own box (no `ring-*`, no outward `shadow-*`, no positive
// `outline-offset`): an outward ring gets clipped by any `overflow: hidden`/`auto` ancestor.
const input = (...twClasses: string[]) => twMerge(`ui-field-box`, ...twClasses);

/** Compact 26px field: a row's cluster, a toolbar, a card strip. Matches the button's `size="small"`. */
const inputSm = (...twClasses: string[]) => twMerge(`ui-field-box ui-field-sm`, ...twClasses);

/** The field that stands where a line of text stood: a rename on a card, a tab title, a tree node. */
const inputInline = (...twClasses: string[]) => twMerge(`ui-field-box ui-field-inline`, ...twClasses);

/** Dashed-border "nothing here yet" empty state placeholder. */
const emptyState = (...twClasses: string[]) =>
    twMerge(`rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted`, ...twClasses);

// Clickable dashed affordance ("add one", "show the rest"); `emptyState` above is its passive counterpart.
// Carries the hover itself (dash firms up, text comes forward) so it reads as a control; geometry beyond radius
// is the caller's.
const addTile = (...twClasses: string[]) =>
    twMerge(
        `ui-off inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-line`,
        `text-xs text-muted transition-colors hover:border-line-strong hover:text-content`,
        ...twClasses,
    );

// Labelled affordance floating on content (a code block's Copy chip), sized by what it sits on, not the button
// scale. Not a <Button>, since it isn't ranked against anything; keeps chrome at rest since it overlays text.
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
    inputSm,
    inputInline,
    emptyState,
    addTile,
    overlayChip,
    sectionLabel,
};
