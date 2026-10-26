import { computed, inject, onBeforeUnmount, onUpdated, provide, shallowReactive, type ComputedRef, type InjectionKey } from "vue";
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
// TWO HEIGHTS PER TIER, AND THE GROUP PICKS ONE. `heightBare` holds a row that is one line (a name, its facts, its
// verbs); `heightDescribed` a row with a line of description under its name. Both leave the same air above and below the
// text, so a bare list reads as tight as it is and a described one as calm. A group is one height: once any row on its
// surface is described, every row there stands at `heightDescribed`, so a bare "Theme" beside a described "Wallpaper" is
// as tall as it (useRowLines below). The heights are floors that hold a face, a small button or a segmented control
// inside the tier's padding; text never raises them, since the title keeps to one line and the description to one (two on
// a phone), so only a row that draws more than a row (a `#below` block, an open drawer, a control that needs a line of
// its own) is taller. `headlineWide` is the headline's basis from `md` up, title-only rows included, so a long title gives
// way to an ellipsis instead of pushing the trailing cluster onto a second line.
// 2026-10-26: the owner found the rows dense and their heights uneven (40px to 71px in one view, a 56px floor only where a
// group asked for one with `equal-rows`). Rejected after trying it: one height for every row (64px), which left bare lists
// (Environment, Secrets, Extensions) a row's worth of empty air per line.
/* A tier is read in one place rather than reassembled from five ternaries down a template. */
export const ROW_TIERS = {
    comfortable: {
        pad: `px-4.5 py-3.5`,
        facePad: `px-4.5 py-2.5`,
        heightBare: `min-h-14`,
        heightDescribed: `min-h-18`,
        gap: `gap-3`,
        icon: `text-xl`,
        title: `font-semibold leading-tight`,
        description: `text-xs`,
        headline: `basis-56`,
        headlineWide: `md:basis-56`,
        mark: 28,
        heading: `sm`,
        headingLine: `gap-x-2.5 gap-y-1`,
        headingLabel: `min-w-0`,
        headingInset: `px-1`,
        headingGap: `mb-2.5`,
    },
    compact: {
        pad: `px-4 py-2.5`,
        facePad: `px-4 py-1`,
        heightBare: `min-h-12`,
        heightDescribed: `min-h-16`,
        gap: `gap-3`,
        icon: `text-lg`,
        title: `text-sm font-medium leading-tight`,
        description: `text-2xs`,
        headline: `basis-44`,
        headlineWide: `md:basis-44`,
        mark: 22,
        heading: `sm`,
        headingLine: `gap-x-2.5 gap-y-1`,
        headingLabel: `min-w-0`,
        headingInset: `px-1`,
        headingGap: `mb-2.5`,
    },
    // Lowest of the three on purpose: the nav rail is a fixed 16rem and its rows carry a chip at most, so a
    // wrap there would be the tier reflowing a column that was never short of room. Its heading truncates for the same
    // reason, and sits in by the rail rows' own inset.
    dense: {
        pad: `px-2.5 py-2`,
        facePad: `px-2.5 py-0.5`,
        heightBare: `min-h-8`,
        heightDescribed: `min-h-12`,
        gap: `gap-2.5`,
        icon: `text-base`,
        title: `text-xs font-medium leading-tight`,
        description: `text-2xs`,
        headline: `basis-24`,
        headlineWide: `md:basis-24`,
        mark: 18,
        heading: `xs`,
        headingLine: `gap-x-2 gap-y-0.5`,
        headingLabel: `min-w-0 truncate`,
        headingInset: `pl-2 pr-1`,
        headingGap: `mb-1`,
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

// WHICH OF ITS TWO HEIGHTS A ROW STANDS AT (`heightBare` / `heightDescribed`). <RowGroup> keeps the set of its described
// rows; each <Row> enters it while it carries a description and reads back whether anyone has, so a group whose rows
// disagree stands at the taller height together. A set rather than a flag, so a row that loses its description, or
// leaves, takes its vote with it. Read after every render as well as at setup: a `#description` slot coming or going is
// not a reactive read, but it always re-renders the row.
interface RowLines {
    readonly described: ComputedRef<boolean>;
    readonly vote: (row: symbol, described: boolean) => void;
}
const ROW_LINES: InjectionKey<RowLines> = Symbol(`ui.row.lines`);

/** Published by <RowGroup>: its rows stand at one height, the described one once any of them is described. */
export const provideRowLines = (): void => {
    const described = shallowReactive(new Set<symbol>());
    provide(ROW_LINES, {
        described: computed(() => described.size > 0),
        vote: (row, on) => {
            if (on) {
                described.add(row);
            } else {
                described.delete(row);
            }
        },
    });
};

/** Whether this row stands at its tier's described height: it is described itself, or a row of its group is. */
export const useRowLines = (own: () => boolean): ComputedRef<boolean> => {
    const group = inject(ROW_LINES, undefined);
    if (group === undefined) {
        return computed(own);
    }
    const row = Symbol(`row`);
    const vote = (): void => group.vote(row, own());
    vote();
    onUpdated(vote);
    onBeforeUnmount(() => group.vote(row, false));
    return computed(() => own() || group.described.value);
};

// WHERE A ROW'S TEXT STARTS. A group on a surface of its own insets its rows by the tier's padding; a group on a dialog
// draws no surface (surfaceGround.ts), so its rows start where the dialog's own words do, and their hairlines run the
// same width. Published by <RowGroup>; a row outside a group keeps its tier's inset.
const ROW_FLUSH_INLINE: InjectionKey<boolean> = Symbol(`ui.row.flushInline`);

/** Published by <RowGroup> when it draws no surface for its rows to be inset on. */
export const provideRowFlushInline = (flush: boolean): void => provide(ROW_FLUSH_INLINE, flush);

/** Whether this row's text starts at its container's edge rather than inside the tier's padding. */
export const useRowFlushInline = (): boolean => inject(ROW_FLUSH_INLINE, false);

// A FLUSH ROW THAT WASHES. Flush, a row's box ends where its text does, so a hover or open wash drawn on that box ran
// right up against the lead mark and the chevron. The washing box bleeds past the text by this much on both sides and
// pays it back as padding, so the text stays aligned with the words around it and the wash gets its own margin.
// `ROW_WASH_BLEED_FULL` is for a box that also sets `w-full`, whose 100% would otherwise fall short on the right.
export const ROW_WASH_BLEED = `-mx-2.5 px-2.5 rounded-lg`;
export const ROW_WASH_BLEED_FULL = `-mx-2.5 !px-2.5 rounded-lg !w-[calc(100%+1.25rem)]`;
