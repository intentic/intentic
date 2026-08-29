import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";

/* <Row>'s geometry, as data, so <DisclosureRow> can build the header's MIRROR out of the same numbers the
 * header itself is drawn from.
 *
 * It lives out here for one reason and it is the reason this whole component exists: a disclosure's expanded
 * body has to start under the row's TITLE, not under the row's edge, and the only honest way to express that
 * offset is "whatever the lead cluster measures". Spelled as a number at the call site it becomes `pl-8` in
 * one file, `pl-9` in two more and `pl-10` in a fourth — four guesses at one distance, each of them stale the
 * first time an icon changes size. <DisclosureRow> draws the cluster a second time and hides it instead, and
 * that copy is only ever right if it reads its gaps from the same table the visible one does. */

/** comfortable: settings rows · compact: record lists · dense: navigator rails. */
export type RowDensity = `comfortable` | `compact` | `dense`;

export type RowTone = `default` | `danger` | `warning` | `success` | `info`;

/* A tier is read in one place rather than reassembled from five ternaries down a template.
 * THE ICON SCALES WITH THE TIER. It used to be a flat `text-lg`, which is right for a settings row and a third
 * too big beside a rail row's `text-xs` title: the icon then reads as the row's subject and the name as its
 * annotation, which is backwards.
 *
 * `mark` IS THE SAME ARGUMENT FOR THE OTHER LEAD, and it is a NUMBER because the components it feeds take
 * pixels. <BrandMark> and <Avatar> each say in writing why they refuse a scale, and they are right: they are
 * drawn at 16 in a chat composer, at 44 on a capability card and at 56 on a profile, and none of those is a row.
 * What was missing is the row's own answer, so seven record lists guessed one each — 22 on the extensions list,
 * the environment contents and the skills list, 20 on the secrets list and the registry browser, 24 on the
 * capability connections, 32 on the personas list — and three of those sit one tab apart from each other.
 *
 * ONE SIZE PER TIER, FACES INCLUDED. A round <PersonaFace> and a square <BrandMark> plate are both 22 in a
 * compact row. A face does read a shade smaller inside the same box, and that is a real optical effect, but the
 * correction costs a second number, a rule about when it applies, and a call site that has to know which kind of
 * mark it is drawing — which is how 32 got there in the first place. <Row> hands this out as a `#lead` slot
 * prop, so no call site types it at all. */
export const ROW_TIERS = {
    comfortable: { pad: `px-4.5 py-3.5`, gap: `gap-3`, icon: `text-lg`, title: `font-semibold leading-tight`, description: `text-xs`, mark: 28 },
    compact: { pad: `px-4 py-2.5`, gap: `gap-3`, icon: `text-sm`, title: `text-sm font-medium leading-tight`, description: `text-2xs`, mark: 22 },
    dense: { pad: `px-2.5 py-2`, gap: `gap-2.5`, icon: `text-xs`, title: `text-xs font-medium leading-tight`, description: `text-2xs`, mark: 18 },
} as const satisfies Record<RowDensity, Record<string, string | number>>;

/* The lead icon's colour, as a tone rather than as a class the caller brings. The three semantic ones are not
 * decoration: they are the card's state said in colour before its sentence is read (a warning triangle on
 * "sandbox is behind the app", an open lock the moment a bundle stops being safe to hand over), and each was
 * previously spelled at its own call site, which is why one of them was `text-base` while its neighbours were
 * `text-lg`. `info` is the link colour, kept off the name `link` because nothing here navigates. */
export const ROW_TONES = {
    default: `text-subtle`,
    danger: `text-danger`,
    warning: `text-warning`,
    success: `text-success`,
    info: `text-link`,
} as const satisfies Record<RowTone, string>;

/* THE GAP INSIDE THE TOGGLE, between the chevron and the row's own mark. Tighter than the tier's gap on
 * purpose: the two glyphs are ONE affordance (see <DisclosureRow>), and spacing them like separate items in
 * the lead cluster is what makes a reader try to press the arrow alone. */
export const ROW_TOGGLE_GAPS = {
    comfortable: `gap-2.5`,
    compact: `gap-2`,
    dense: `gap-1.5`,
} as const satisfies Record<RowDensity, string>;

/* THE CHEVRON SCALES WITH THE TIER, one notch under the tier's own icon: it is the row's punctuation, not its
 * subject. A flat size is what a hand-rolled disclosure reaches for, and every one of them picked `text-2xs`,
 * which is right beside a compact row's 14px mark and visibly stunted beside a settings row's 19px one. */
export const ROW_TOGGLE_SIZES = {
    comfortable: `text-xs`,
    compact: `text-2xs`,
    dense: `text-2xs`,
} as const satisfies Record<RowDensity, string>;

/* PADDING FOR A BLOCK ON A ROW'S SURFACE rather than for a row: a drawer's contents under an open row, a form
 * at the tail of a list, the figure a group leads with. Matched to the row's own horizontally so the two read as
 * one surface rather than as a panel that missed its edges by two pixels, and a shade roomier vertically on
 * purpose — a block holds a form, not a line.
 *
 * Out here rather than inside <DisclosureRow> because it was needed twice: the drawer, and <RowNote>'s `block`.
 * The second one is the eight places a view dropped a form or a figure straight onto a <RowGroup> and picked its
 * own padding — `px-4 py-2.5`, `px-4 py-3`, `px-4 py-4`, `px-4.5 py-3.5`, `px-4.5 py-4` — five answers to one
 * question, three of which match no tier in this file. */
export const ROW_BLOCK_PAD = {
    comfortable: `px-4.5 py-4`,
    compact: `px-4 py-3.5`,
    dense: `px-2.5 py-3`,
} as const satisfies Record<RowDensity, string>;

/* ── THE TIER BELONGS TO THE LIST ────────────────────────────────────────────────────────────────────────────
 *
 * A tier per CALL SITE was the whole of the drift. Every one of <Row>, <DisclosureRow> and <SkeletonRows>
 * defaulted to `comfortable` on its own, so a record list was compact only while each of its rows, its loading
 * outline and each hand-written line in it independently remembered to say so — and the moment one of them
 * forgot, that one rendered as a settings row in the middle of a record list, which is precisely how:
 *
 *   · the extensions list drew ~67px rows one tab along from the secrets list's ~40px ones. It was the only
 *     <DisclosureRow> in the app with no `density`, and its own header comment describes the compact row it
 *     believed it was ("22px inside a 40px row");
 *   · the personas list's loading outline promised comfortable rows and then landed compact ones, so the list
 *     visibly shrank as it arrived;
 *   · the payouts page did the same, under a comment stating the exact opposite: "it renders REAL <Row>s, so
 *     the outline inherits this page's padding and density by construction instead of drifting from it". The
 *     intent was right and there was no mechanism under it. This is that mechanism.
 *
 * So the tier is declared ONCE, on the <RowGroup>, and everything inside it reads the group's answer. That is
 * the same argument <RowGroup> already makes about its selection column — a fact about the LIST, not about any
 * row in it — and it is what turns "remember `density` at 60 call sites" into "say it once per list".
 *
 * AN EXPLICIT PROP STILL WINS, because one row inside a group legitimately disagrees: a card's masthead is a
 * `flush :heading="2"` <Row> sitting above compact rows on the same surface, and it is comfortable by rank
 * rather than by list. That is a stated exception at a call site, which is a different thing from a default
 * nobody chose.
 *
 * Outside a group the fallback is `comfortable`, which is what every one of these components defaulted to
 * before: a bare <Row> on a card is a settings row, and that has not changed. */
const ROW_DENSITY: InjectionKey<ComputedRef<RowDensity>> = Symbol(`ui.row.density`);

/** Published by <RowGroup> for every row, outline and note on its surface. */
export const provideRowDensity = (density: ComputedRef<RowDensity>): void => provide(ROW_DENSITY, density);

/**
 * The tier this row is being drawn at: what the caller asked for, else the group's, else `comfortable`.
 * `own` is the component's own `density` prop, which is `undefined` when the call site left it to the list.
 */
export const useRowDensity = (own: () => RowDensity | undefined): ComputedRef<RowDensity> => {
    const group = inject(ROW_DENSITY, undefined);
    return computed(() => own() ?? group?.value ?? `comfortable`);
};
