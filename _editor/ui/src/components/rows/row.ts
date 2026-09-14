import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";

// Row geometry as data, so <DisclosureRow> can build its header mirror from the same numbers the visible
// header uses, rather than a typed offset (`pl-8`, `pl-9`...) that goes stale the moment an icon changes size.

// Three tiers: `compact` is what <RowGroup> defaults every list to; `dense` is the nav rail; `comfortable`
// is a card masthead (a `flush :heading="2"` <Row>, outside any group).
export type RowDensity = `comfortable` | `compact` | `dense`;

export type RowTone = `default` | `danger` | `warning` | `success` | `info`;

/* A tier is read in one place rather than reassembled from five ternaries down a template. */
export const ROW_TIERS = {
    comfortable: { pad: `px-4.5 py-3.5`, gap: `gap-3`, icon: `text-xl`, title: `font-semibold leading-tight`, description: `text-xs`, mark: 28 },
    compact: { pad: `px-4 py-2.5`, gap: `gap-3`, icon: `text-lg`, title: `text-sm font-medium leading-tight`, description: `text-2xs`, mark: 22 },
    dense: { pad: `px-2.5 py-2`, gap: `gap-2.5`, icon: `text-base`, title: `text-xs font-medium leading-tight`, description: `text-2xs`, mark: 18 },
} as const satisfies Record<RowDensity, Record<string, string | number>>;

// Lead icon colour by state, said before the sentence is read. `info` is the link colour, not named
// `link`, since nothing here navigates.
export const ROW_TONES = {
    default: `text-muted`,
    danger: `text-danger`,
    warning: `text-warning`,
    success: `text-success`,
    info: `text-link`,
} as const satisfies Record<RowTone, string>;

// Gap inside the toggle, tighter than the tier's own gap: the chevron and lead mark read as one affordance.
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
