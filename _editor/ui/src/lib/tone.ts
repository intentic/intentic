import { tv } from "tailwind-variants";

/* THE APP'S ONE TONE VOCABULARY, and the only file that may spell a tone as a tint.

   Before this file there were thirteen tone types (`ok`/`warn` beside `success`/`warning`) and every component that
   drew a status wrote its own table: 147 hand-written tints in 78 files, at seven fill strengths and six rim strengths,
   so two boxes that both meant "danger" rarely agreed on how loudly. A tone is now chosen by NAME here and drawn by
   one of five recipes below; `_tools/checks/tone-tiers.mjs` refuses a tint written anywhere else.

   Every value is spelled out per tone, never templated: Tailwind only emits a utility it can see used literally. */

/** What a state means, not what colour it is. `neutral` is the resting state; `primary` is the app's own accent. */
export type Tone = `success` | `warning` | `danger` | `info` | `neutral` | `primary`;

/** The four tones that report something (a status, a failure); the subset a notice or a tint can wear. */
export type Signal = Exclude<Tone, `neutral` | `primary`>;

/** How loudly a tinted box speaks. `strong`: a message the user should read (a notice, a refusal, a done receipt).
 *  `soft`: a region that belongs to a state without shouting it (a panel of failures, a security-fix offer). */
export type TintWeight = `strong` | `soft`;

const TONES = {
    success: ``,
    warning: ``,
    danger: ``,
    info: ``,
    neutral: ``,
    primary: ``,
} as const satisfies Record<Tone, string>;

/** The tone as text: a status word, a glyph, a figure. */
const inkRecipe = tv({
    variants: {
        tone: {
            success: `text-success`,
            warning: `text-warning`,
            danger: `text-danger`,
            info: `text-info`,
            neutral: `text-subtle`,
            primary: `text-primary-500`,
        },
    },
});

/** The tone as a solid mark: a status dot, a meter's fill, a bar. */
const dotRecipe = tv({
    variants: {
        tone: {
            success: `bg-success`,
            warning: `bg-warning`,
            danger: `bg-danger`,
            info: `bg-info`,
            neutral: `bg-subtle`,
            primary: `bg-primary-500`,
        },
    },
});

/** A borderless wash with the tone's ink: a status pill, a badge, a highlighted word. One strength, for every tone. */
const washRecipe = tv({
    variants: {
        tone: {
            success: `bg-success/10 text-success`,
            warning: `bg-warning/10 text-warning`,
            danger: `bg-danger/10 text-danger`,
            info: `bg-info/10 text-info`,
            neutral: `bg-subtle/10 text-subtle`,
            primary: `bg-primary-600/10 text-primary-500`,
        },
    },
});

// A rim and a fill, never ink and never geometry: whether the box is `border` or `border-b`, rounded or flush, and
// whether its sentence wears the tone or the content colour are the caller's. Two strengths and no third. The halves
// exist on their own for a box that keeps one of its own: a chip's resting fill under a tone's rim, a row whose
// hairline belongs to its group under a tone's fill.
const rimRecipe = tv({
    variants: { tone: TONES, weight: { strong: ``, soft: `` } },
    compoundVariants: [
        { tone: `success`, weight: `strong`, class: `border-success/40` },
        { tone: `warning`, weight: `strong`, class: `border-warning/40` },
        { tone: `danger`, weight: `strong`, class: `border-danger/40` },
        { tone: `info`, weight: `strong`, class: `border-info/40` },
        { tone: `neutral`, weight: `strong`, class: `border-line-strong` },
        { tone: `primary`, weight: `strong`, class: `border-primary-500/40` },
        { tone: `success`, weight: `soft`, class: `border-success/20` },
        { tone: `warning`, weight: `soft`, class: `border-warning/20` },
        { tone: `danger`, weight: `soft`, class: `border-danger/20` },
        { tone: `info`, weight: `soft`, class: `border-info/20` },
        { tone: `neutral`, weight: `soft`, class: `border-line` },
        { tone: `primary`, weight: `soft`, class: `border-primary-500/20` },
    ],
});

const fillRecipe = tv({
    variants: { tone: TONES, weight: { strong: ``, soft: `` } },
    compoundVariants: [
        { tone: `success`, weight: `strong`, class: `bg-success/10` },
        { tone: `warning`, weight: `strong`, class: `bg-warning/10` },
        { tone: `danger`, weight: `strong`, class: `bg-danger/10` },
        { tone: `info`, weight: `strong`, class: `bg-info/10` },
        { tone: `neutral`, weight: `strong`, class: `bg-overlay` },
        { tone: `primary`, weight: `strong`, class: `bg-primary-500/10` },
        { tone: `success`, weight: `soft`, class: `bg-success/5` },
        { tone: `warning`, weight: `soft`, class: `bg-warning/5` },
        { tone: `danger`, weight: `soft`, class: `bg-danger/5` },
        { tone: `info`, weight: `soft`, class: `bg-info/5` },
        { tone: `neutral`, weight: `soft`, class: `bg-canvas` },
        { tone: `primary`, weight: `soft`, class: `bg-primary-500/5` },
    ],
});

// A PLATE IS THE TONE'S OWN INK, INVERTED — painted rather than written, with the surface those inks were measured
// against as the label. Opaque, because a wash reads as part of whatever it sits on instead of as something laid on
// it. Inverting the ink rather than reaching for `*-fill` keeps a skin's own accent: every skin tunes these inks to be
// legible against its canvas, so the contrast comes with them.
const plateRecipe = tv({
    variants: {
        tone: {
            success: `bg-success text-canvas`,
            warning: `bg-warning text-canvas`,
            danger: `bg-danger text-canvas`,
            info: `bg-link text-canvas`,
            neutral: `bg-muted text-canvas`,
            primary: `bg-primary-500 text-canvas`,
        },
    },
});

/** A pressable thing that turns the tone on hover: a destructive icon, a fix-stance chip. Rest is the caller's. */
const hoverRecipe = tv({
    variants: {
        tone: {
            success: `hover:bg-success/10 hover:text-success active:bg-success/10 active:text-success`,
            warning: `hover:bg-warning/10 hover:text-warning active:bg-warning/10 active:text-warning`,
            danger: `hover:bg-danger/10 hover:text-danger active:bg-danger/10 active:text-danger`,
            info: `hover:bg-info/10 hover:text-info active:bg-info/10 active:text-info`,
            neutral: `hover:bg-overlay hover:text-content active:bg-overlay active:text-content`,
            primary: `hover:bg-primary-500/10 hover:text-primary-500 active:bg-primary-500/10 active:text-primary-500`,
        },
    },
});

type ClassArg = string | false | null | undefined;

/** `text-danger`: the tone as text. */
export const toneInk = (tone: Tone, ...classes: ClassArg[]): string => inkRecipe({ tone, class: classes });
/** `bg-danger`: the tone as a solid dot or fill. */
export const toneDot = (tone: Tone, ...classes: ClassArg[]): string => dotRecipe({ tone, class: classes });
/** `bg-danger/10 text-danger`: a borderless pill or badge. */
export const toneWash = (tone: Tone, ...classes: ClassArg[]): string => washRecipe({ tone, class: classes });
/** `border-danger/40 bg-danger/10`: the colours of a tinted box; the caller states `border`/`border-b` and the shape. */
export const toneTint = (tone: Tone, weight: TintWeight = `strong`, ...classes: ClassArg[]): string =>
    rimRecipe({ tone, weight, class: [fillRecipe({ tone, weight }), ...classes] });
/** `border-danger/40`: the tint's rim alone, over a fill the box keeps (a chip's plate, a floating card's). */
export const toneRim = (tone: Tone, weight: TintWeight = `strong`, ...classes: ClassArg[]): string => rimRecipe({ tone, weight, class: classes });
/** `bg-danger/10`: the tint's fill alone, under a rule the box doesn't own (a row's hairline in its group). */
export const toneFill = (tone: Tone, weight: TintWeight = `strong`, ...classes: ClassArg[]): string => fillRecipe({ tone, weight, class: classes });
/** `bg-danger text-canvas`: an opaque plate (a count badge). */
export const tonePlate = (tone: Tone, ...classes: ClassArg[]): string => plateRecipe({ tone, class: classes });
/** The tone arriving under the pointer, for a control that is neutral at rest. */
export const toneHover = (tone: Tone, ...classes: ClassArg[]): string => hoverRecipe({ tone, class: classes });

/* A DIFF'S THREE MARKS, which are tones with a fixed meaning: what was added reads as success, what was removed as
   danger, what changed as warning. Every viewer that compares two versions (prose, tables, documents) draws them from
   here, so an insertion looks the same in a Markdown diff as in a spreadsheet's. */
export type DiffMark = `added` | `removed` | `changed`;

const diffRecipe = tv({
    variants: {
        mark: { added: ``, removed: ``, changed: `` },
        // `inline`: a run of words inside a line. `rule`: a whole line or row, marked by a bar down its left edge.
        as: { inline: ``, rule: `border-l-2` },
    },
    compoundVariants: [
        { mark: `added`, as: `inline`, class: `rounded-sm bg-success/15 no-underline decoration-success underline decoration-2 underline-offset-2` },
        { mark: `removed`, as: `inline`, class: `rounded-sm bg-danger/10 text-muted line-through decoration-danger/70` },
        { mark: `changed`, as: `inline`, class: `rounded-sm bg-warning/15` },
        { mark: `added`, as: `rule`, class: `border-success/60` },
        { mark: `removed`, as: `rule`, class: `border-danger/60` },
        { mark: `changed`, as: `rule`, class: `border-warning/60` },
    ],
});

/** A diff mark: `diffMark('added')` for inserted words, `diffMark('removed', 'rule')` for a deleted row's edge. */
export const diffMark = (mark: DiffMark, as: `inline` | `rule` = `inline`, ...classes: ClassArg[]): string =>
    diffRecipe({ mark, as, class: classes });
