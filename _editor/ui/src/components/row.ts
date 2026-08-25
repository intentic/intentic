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
 * annotation, which is backwards. */
export const ROW_TIERS = {
    comfortable: { pad: `px-4.5 py-3.5`, gap: `gap-3`, icon: `text-lg`, title: `font-semibold leading-tight`, description: `text-xs` },
    compact: { pad: `px-4 py-2.5`, gap: `gap-3`, icon: `text-sm`, title: `text-sm font-medium leading-tight`, description: `text-2xs` },
    dense: { pad: `px-2.5 py-2`, gap: `gap-2.5`, icon: `text-xs`, title: `text-xs font-medium leading-tight`, description: `text-2xs` },
} as const satisfies Record<RowDensity, Record<string, string>>;

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
