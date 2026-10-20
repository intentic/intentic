import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";
import { toneInk } from "../../lib/tone.js";

// Row geometry as data, so <DisclosureRow> can build its header mirror from the same numbers the visible
// header uses, rather than a typed offset (`pl-8`, `pl-9`...) that goes stale the moment an icon changes size.

// Three tiers: `compact` is what <RowGroup> defaults every list to; `dense` is the nav rail; `comfortable`
// is a card masthead (a `flush :heading="2"` <Row>, outside any group).
export type RowDensity = `comfortable` | `compact` | `dense`;

export type RowTone = `default` | `danger` | `warning` | `success` | `info`;

// `headline` is the width the title column refuses to go below: it is the headline's flex-basis, so once the
// trailing cluster can no longer sit beside that much text the cluster wraps to its own line instead of
// squeezing the title into one word per line. A floor, not a size — with room the headline still takes the rest.
// `facePad` is what the row pays when `#lead` draws a face instead of a glyph (FACE_SIZES.row, half again the
// tier's `mark`): the extra box comes out of the row's own vertical padding, so a faced row is the same height.
// THE HEADER IS THE TIER'S TOO (<SectionHeader>, which <RowGroup>, <Section> and <NavRail> draw): `heading` is the
// label's size, `headingLine` the line's own spacing, `headingLabel` how the label fits it, `headingInset` how far it
// sits in from the rows' card under it (none on a dialog or a card, which are the surface), and `headingGap` the room
// between the header and what it heads. The list or section owns the last two, not the header: a header alone in a
// toolbar or a label column is the line and nothing else. A view never states any of the three, which is what let a dozen views each
// grow a count, a caption or a band behind their header before the header had one owner.
// `floor` is the one height a settings group's rows share (<RowGroup equal-rows>): a floor, not the tallest row, so a
// row that wraps a wide control is the only tall one rather than the reason every row is.
/* A tier is read in one place rather than reassembled from five ternaries down a template. */
export const ROW_TIERS = {
    comfortable: {
        pad: `px-4.5 py-3.5`,
        facePad: `px-4.5 py-2.5`,
        gap: `gap-3`,
        icon: `text-xl`,
        title: `font-semibold leading-tight`,
        description: `text-xs`,
        headline: `basis-56`,
        mark: 28,
        heading: `sm`,
        headingLine: `gap-x-2.5 gap-y-1`,
        headingLabel: `min-w-0`,
        headingInset: `px-1`,
        headingGap: `mb-2.5`,
        floor: `md:*:min-h-16`,
    },
    compact: {
        pad: `px-4 py-2.5`,
        facePad: `px-4 py-1`,
        gap: `gap-3`,
        icon: `text-lg`,
        title: `text-sm font-medium leading-tight`,
        description: `text-2xs`,
        headline: `basis-44`,
        mark: 22,
        heading: `sm`,
        headingLine: `gap-x-2.5 gap-y-1`,
        headingLabel: `min-w-0`,
        headingInset: `px-1`,
        headingGap: `mb-2.5`,
        floor: `md:*:min-h-14`,
    },
    // Lowest of the three on purpose: the nav rail is a fixed 16rem and its rows carry a chip at most, so a
    // wrap there would be the tier reflowing a column that was never short of room. Its heading truncates for the same
    // reason, and sits in by the rail rows' own inset.
    dense: {
        pad: `px-2.5 py-2`,
        facePad: `px-2.5 py-0.5`,
        gap: `gap-2.5`,
        icon: `text-base`,
        title: `text-xs font-medium leading-tight`,
        description: `text-2xs`,
        headline: `basis-24`,
        mark: 18,
        heading: `xs`,
        headingLine: `gap-x-2 gap-y-0.5`,
        headingLabel: `min-w-0 truncate`,
        headingInset: `pl-2 pr-1`,
        headingGap: `mb-1`,
        floor: `md:*:min-h-12`,
    },
} as const satisfies Record<RowDensity, Record<string, string | number>>;

// Lead icon colour by state, said before the sentence is read. `info` is the link colour, not named
// `link`, since nothing here navigates.
export const ROW_TONES: Record<RowTone, string> = {
    default: `text-muted`,
    danger: toneInk(`danger`),
    warning: toneInk(`warning`),
    success: toneInk(`success`),
    info: `text-link`,
};

// Gap inside a row note's own toggle cluster, tighter than the tier's own gap.
export const ROW_TOGGLE_GAPS = {
    comfortable: `gap-2.5`,
    compact: `gap-2`,
    dense: `gap-1.5`,
} as const satisfies Record<RowDensity, string>;

// The chevron's size, one notch under the tier's own icon: it's punctuation, not the row's subject.
export const ROW_TOGGLE_SIZES = {
    comfortable: `text-xs`,
    compact: `text-2xs`,
    dense: `text-2xs`,
} as const satisfies Record<RowDensity, string>;

// Padding for a block on a row's surface (a drawer's contents, a form at a list's tail): matched to the
// row's own horizontal padding, roomier vertically.
export const ROW_BLOCK_PAD = {
    comfortable: `px-4.5 py-4`,
    compact: `px-4 py-3.5`,
    dense: `px-2.5 py-3`,
} as const satisfies Record<RowDensity, string>;

// Padding for a drawer under an open row; asymmetric, since the row's own bottom padding already
// separates header from body.
export const ROW_DRAWER_PAD = {
    comfortable: `px-4.5 pt-2 pb-4`,
    compact: `px-4 pt-1.5 pb-3.5`,
    dense: `px-2.5 pt-1 pb-3`,
} as const satisfies Record<RowDensity, string>;

// The tier is declared once, on <RowGroup>, and everything inside reads its answer, rather than each of
// <Row>, <DisclosureRow> and <SkeletonRows> defaulting to `comfortable` independently and drifting apart.
// An explicit prop still wins, for a row that legitimately disagrees. Outside a group the fallback is
// `comfortable`, the masthead's own tier, not a leftover default.
const ROW_DENSITY: InjectionKey<ComputedRef<RowDensity>> = Symbol(`ui.row.density`);

/** Published by <RowGroup> for every row, outline and note on its surface. */
export const provideRowDensity = (density: ComputedRef<RowDensity>): void => provide(ROW_DENSITY, density);

/** The tier this row draws at: what the caller asked for, else the group's, else `comfortable`. */
export const useRowDensity = (own: () => RowDensity | undefined): ComputedRef<RowDensity> => {
    const group = inject(ROW_DENSITY, undefined);
    return computed(() => own() ?? group?.value ?? `comfortable`);
};

// WHERE A ROW'S TEXT STARTS. A group on a surface of its own insets its rows by the tier's padding; a group on a dialog
// draws no surface (surfaceGround.ts), so its rows start where the dialog's own words do, and their hairlines run the
// same width. Published by <RowGroup>; a row outside a group keeps its tier's inset.
const ROW_FLUSH_INLINE: InjectionKey<boolean> = Symbol(`ui.row.flushInline`);

/** Published by <RowGroup> when it draws no surface for its rows to be inset on. */
export const provideRowFlushInline = (flush: boolean): void => provide(ROW_FLUSH_INLINE, flush);

/** Whether this row's text starts at its container's edge rather than inside the tier's padding. */
export const useRowFlushInline = (): boolean => inject(ROW_FLUSH_INLINE, false);
