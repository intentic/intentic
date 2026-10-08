import { tv } from "tailwind-variants";
import { toneHover } from "./tone.js";

// THE KIT'S CLASS RECIPES. Each is a `tv()` recipe: a base, named variants (size, tone, state) and the caller's own
// classes last, merged by twMerge so the caller's LAYOUT always wins. What a recipe varies is chosen by name, never
// by overriding its classes: `ui.textButton({ size: "xs", tone: "quiet" })`, not `ui.linkButton("text-2xs
// text-muted hover:text-content")`. `_tools/checks/recipe-tiers.mjs` refuses a size, an ink or a radius passed as a
// class to a recipe that has a variant for it.
//
// Two ways to call each one, and the second is not legacy to be removed: installed extensions call `ui.*` through
// the host at runtime, built against whatever kit was published when they were, so `ui.iconButton("h-8 w-8")` keeps
// working for them. In this repository the first argument is the variants object.
//   ui.iconButton({ size: "lg", tone: "danger" }, "shrink-0")
//   ui.iconButton("shrink-0")
//
// The public variant types below are written out rather than inferred from `tv()`, because the extension kit's
// published declarations carry them and must not depend on tailwind-variants' own types.

// The action button is <Button>, in four tiers and two sizes (Button.vue, primeng.css); no other `button*` recipe
// exists. Not <Button> at all: `ui.iconButton()` (bare glyph), `ui.textButton()` (a line of text that acts: a link
// that navigates, or a quieter action in place), `ui.chip()` (state, not rank), `ui.overlayChip()` (floats on
// content).

export type ClassArg = string | false | null | undefined;

/** Every recipe's call shape: variants first (optional), then the caller's layout classes. */
export type Recipe<V> = (variants?: V | ClassArg, ...classes: ClassArg[]) => string;

// The shared disabled state for chrome-less controls: there is no fill to dim at rest.
const OFF = `disabled:cursor-default disabled:text-subtle disabled:hover:text-subtle`;

const recipe =
    <V extends object>(build: (props: V & { class?: ClassArg[] }) => string): Recipe<V> =>
    (first, ...rest) =>
        typeof first === `object` && first !== null
            ? build({ ...first, class: rest })
            : build({ class: [first, ...rest] } as V & { class: ClassArg[] });

// ── ICON BUTTON ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface IconButtonVariants {
    /** `xs` 20px (a mark inside a line), `sm` 24px (default: a row's or a header's glyph), `md` 28px (a toolbar), `lg`
     *  32px (a pane's own header, a card's corner), `xl` 40px (a rail or a phone bar's tile). Radius follows the size. */
    size?: `xs` | `sm` | `md` | `lg` | `xl`;
    /** `muted` (default) and `subtle` are how loud it is at rest; `danger` is destructive: neutral at rest, danger under
     *  the pointer, so a row of glyphs doesn't shout until you reach for the one that deletes. */
    tone?: `muted` | `subtle` | `danger`;
    /** A circle rather than a rounded square: an avatar's menu, a floating close. */
    round?: boolean;
    /** Pressed: the panel it opens is open, the mode it toggles is on. */
    on?: boolean;
}

// `touch-target` grows the hit area to 44px on a coarse pointer while the drawn box stays the size's.
const iconButtonRecipe = tv({
    base: [
        `touch-target flex shrink-0 cursor-pointer items-center justify-center transition-colors`,
        `hover:bg-overlay hover:text-content active:bg-overlay active:text-content`,
        `${OFF} disabled:hover:bg-transparent`,
    ],
    variants: {
        size: {
            xs: `h-5 w-5 rounded`,
            sm: `h-6 w-6 rounded-md`,
            md: `h-7 w-7 rounded-md`,
            lg: `h-8 w-8 rounded-md`,
            xl: `h-10 w-10 rounded-lg`,
        },
        tone: {
            muted: `text-muted`,
            subtle: `text-subtle`,
            danger: [`text-muted`, toneHover(`danger`)],
        },
        round: { true: `rounded-full` },
        on: { true: `bg-overlay text-content` },
    },
    defaultVariants: { size: `sm`, tone: `muted` },
});

/** A bare glyph that acts. */
const iconButton: Recipe<IconButtonVariants> = recipe((props: IconButtonVariants & { class?: ClassArg[] }) => iconButtonRecipe(props));

// ── TEXT BUTTON ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface TextButtonVariants {
    /** `link` (default) navigates and underlines under the pointer; `quiet` and `subtle` act in place and come forward
     *  under it; `danger` is a destructive word in a line ("Remove"). */
    tone?: `link` | `quiet` | `subtle` | `danger`;
    /** `sm` (default) 12px, `xs` 11px for a dense surface. The gap to an icon steps down with it. */
    size?: `xs` | `sm`;
    /** Sits inside a line of text: no 36px tap-target growth, so it doesn't push the line apart. */
    flush?: boolean;
}

// 36px tap target via negative margin, so the line it sits in keeps its height; `w-fit`, not `self-start` (which
// centres, not shrink-wraps, in a row).
const textButtonRecipe = tv({
    base: [`-my-1.5 flex min-h-9 w-fit cursor-pointer items-center text-left transition-colors`, OFF],
    variants: {
        tone: {
            link: `text-link hover:underline active:underline disabled:hover:no-underline`,
            quiet: `text-muted hover:text-content active:text-content`,
            subtle: `text-subtle hover:text-content active:text-content`,
            danger: `text-danger hover:underline active:underline disabled:hover:no-underline`,
        },
        size: {
            sm: `gap-1.5 text-xs`,
            xs: `gap-1 text-2xs`,
        },
        flush: { true: `my-0 min-h-0` },
    },
    defaultVariants: { tone: `link`, size: `sm` },
});

/** A line of text that acts. */
const textButton: Recipe<TextButtonVariants> = recipe((props: TextButtonVariants & { class?: ClassArg[] }) => textButtonRecipe(props));

/** @deprecated `ui.textButton()`; kept because installed extensions call it through the host. */
const linkButton = (...classes: ClassArg[]): string => textButtonRecipe({ tone: `link`, class: classes });
/** @deprecated `ui.textButton({ tone: "quiet" })`; kept because installed extensions call it through the host. */
const textAction = (...classes: ClassArg[]): string => textButtonRecipe({ tone: `quiet`, class: classes });

// ── FIELD ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// The text field is `ui-field-box`, in three variants; nothing else.
// - `md` (default): the framed 38px field, for a page, dialog, settings card or standalone filter.
// - `sm`: the framed 26px field for a dense surface (a row's cluster, a toolbar), matching the button's `size="small"`.
// - `inline`: replaces text in place (a title being renamed, a tab, a tree node); no rim, takes the surrounding font.
// - `.field-bare` (a class, not a variant): the field whose frame belongs to a parent wrapper (the chat composer, a
//   SearchBar); the wrapper answers `:focus-within` for the whole assembly.
// A call site passes layout and content classes only (width, flex, margin, `resize-y`, `font-mono`), never padding,
// text size, radius, fill or a focus rule (`_tools/checks/input-tiers.mjs`). A field's focus ring never paints outside
// its own box: an outward ring gets clipped by any `overflow: hidden`/`auto` ancestor.

export interface InputVariants {
    size?: `md` | `sm` | `inline`;
}

const inputRecipe = tv({
    base: `ui-field-box`,
    variants: { size: { md: ``, sm: `ui-field-sm`, inline: `ui-field-inline` } },
    defaultVariants: { size: `md` },
});

const input: Recipe<InputVariants> = recipe((props: InputVariants & { class?: ClassArg[] }) => inputRecipe(props));
/** @deprecated `ui.input({ size: "sm" })`; kept because installed extensions call it through the host. */
const inputSm = (...classes: ClassArg[]): string => inputRecipe({ size: `sm`, class: classes });
/** @deprecated `ui.input({ size: "inline" })`; kept because installed extensions call it through the host. */
const inputInline = (...classes: ClassArg[]): string => inputRecipe({ size: `inline`, class: classes });

// ── PLACEHOLDERS ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Dashed-border "nothing here yet" placeholder. Its padding is the caller's: it sits in spaces of every height. */
const emptyStateRecipe = tv({ base: `rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted` });
const emptyState: Recipe<object> = recipe((props: { class?: ClassArg[] }) => emptyStateRecipe(props));

// Clickable dashed affordance ("add one", "show the rest"); `emptyState` above is its passive counterpart. Carries the
// hover itself (dash firms up, text comes forward) so it reads as a control; geometry beyond the radius is the caller's,
// since it stands in for whatever it would add (a row, a card, a rail tile).
const addTileRecipe = tv({
    base: [
        `ui-off inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-line`,
        `text-xs text-muted transition-colors hover:border-line-strong hover:text-content active:border-line-strong active:text-content`,
    ],
});
const addTile: Recipe<object> = recipe((props: { class?: ClassArg[] }) => addTileRecipe(props));

// ── CHIPS ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ChipVariants {
    /** Lit: the filter is applied, the option is the chosen one. */
    on?: boolean;
}

// Chips carry state; buttons carry actions. `.ui-chip` keeps its CSS (utilities.css): the coarse-pointer target is an
// `::after`, and its lit hover has to outrank its resting one. The recipe is how a template asks for it, so the lit
// state is a variant rather than forty ternaries each spelling `ui-chip-on`.
const chipRecipe = tv({ base: `ui-chip`, variants: { on: { true: `ui-chip-on` } } });
const chip: Recipe<ChipVariants> = recipe((props: ChipVariants & { class?: ClassArg[] }) => chipRecipe(props));

// Labelled affordance floating on content (a code block's Copy chip), sized by what it sits on, not the button scale.
// Not a <Button>, since it isn't ranked against anything; keeps chrome at rest since it overlays text.
const overlayChipRecipe = tv({
    base: [
        `touch-target inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-0.5`,
        `text-2xs text-muted transition-colors hover:border-line-strong hover:text-content active:border-line-strong active:text-content`,
        OFF,
    ],
});
const overlayChip: Recipe<object> = recipe((props: { class?: ClassArg[] }) => overlayChipRecipe(props));

// ── LABELS AND TABS ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SectionLabelVariants {
    /** `sm` (default) 12px over a page's or a card's group; `xs` 11px on a dense surface (a status bar's panel, a
     *  rail's group, a group inside a card). */
    size?: `sm` | `xs`;
    /** `neutral` (default); a group that IS a state ("FAILED", "NEEDS YOU") heads itself in that state's ink. */
    tone?: `neutral` | `danger` | `warning` | `success`;
}

/** Uppercase section heading ("CONNECTIONS", "YOUR APPS"). */
const sectionLabelRecipe = tv({
    base: `font-semibold uppercase tracking-wide`,
    variants: {
        size: { sm: `text-xs`, xs: `text-2xs` },
        tone: { neutral: `text-subtle`, danger: `text-danger`, warning: `text-warning`, success: `text-success` },
    },
    defaultVariants: { size: `sm`, tone: `neutral` },
});
const sectionLabel: Recipe<SectionLabelVariants> = recipe((props: SectionLabelVariants & { class?: ClassArg[] }) => sectionLabelRecipe(props));
/** @deprecated `ui.sectionLabel({ size: "xs" })`; kept because installed extensions call it through the host. */
const sectionLabelSm = (...classes: ClassArg[]): string => sectionLabelRecipe({ size: `xs`, class: classes });

export interface TabVariants {
    active?: boolean;
}

// One tab in a row that says which view a column or a pane is showing (the workspace's file strip,
// `SegmentedControl variant="underline"`). The inactive tab carries a TRANSPARENT rule of the same weight, so moving
// the selection shifts nothing. Ink and rule carry the state, never WEIGHT: a bolder label is a wider label, so the
// tabs beside it would move by a pixel every time the selection does. Fill and separators belong to the strip.
const tabRecipe = tv({
    base: `cursor-pointer border-b-2 transition-colors`,
    variants: {
        active: {
            true: `border-b-primary-500 text-content`,
            false: `border-b-transparent text-muted hover:text-content active:text-content`,
        },
    },
    defaultVariants: { active: false },
});

/** `ui.tab(active, ...classes)`, the shape extensions were given; `ui.tab({ active }, ...classes)` reads the same. */
const tab = (active: boolean | TabVariants, ...classes: ClassArg[]): string =>
    tabRecipe({ active: typeof active === `boolean` ? active : (active.active ?? false), class: classes });

export const ui = {
    iconButton,
    textButton,
    linkButton,
    textAction,
    input,
    inputSm,
    inputInline,
    emptyState,
    addTile,
    chip,
    overlayChip,
    sectionLabel,
    sectionLabelSm,
    tab,
};
