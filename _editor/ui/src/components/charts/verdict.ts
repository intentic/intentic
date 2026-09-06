/* <Verdict>'s tone and rank tables, as data, for the same reason <Row>'s geometry is (row.ts): they were being
 * restated wherever a measured answer is drawn, and a restated table is a table that drifts.
 *
 * THE TONE MAP EXISTED TWICE, VERBATIM, in two files reporting the SAME experiments — the Usage tab's
 * <SavingsCard> and the agent settings' <MeasurementPanel>. Two copies of a three-entry map is not an expensive
 * bug; it is the tell that those two files are one component at two sizes, which is what this component is. */

/** What kind of answer this is. `success` is reserved for a saving that was actually MEASURED, never for an
 *  experiment that is merely running: "Measuring" and "Off" are `muted`, and a regression is `content`. */
export type VerdictTone = `success` | `content` | `muted`;

export const VERDICT_TONES = {
    success: `text-success`,
    content: `text-content`,
    muted: `text-muted`,
} as const satisfies Record<VerdictTone, string>;

/* THREE RANKS, AND THE SURFACE PICKS — not the caller's sense of how important its number feels. The same rule
 * <Button> and `ui.input()` state about their two sizes, and the one <RowGroup> had to learn the hard way.
 *
 *   `lg`   a CARD's hero. The answer is why the card exists, so it is the biggest thing on it.
 *   `sm`   a ROW's reading. It sits under a setting, one rank below that setting's own title.
 *   `xs`   a SECOND reading of the same subject. An experiment has exactly one headline and the others are
 *          footnotes to it; drawn as peers they read as competing answers rather than as one qualified answer.
 *
 * `tabular-nums` on every rank, applied by the component. These are live figures that change under the reader
 * as data arrives, and proportional digits make a value shift sideways when 22.2% becomes 11.1%. <StatStrip>
 * deliberately does the opposite and says why: its numbers are static labels, not a readout. */
export type VerdictSize = `lg` | `sm` | `xs`;

/* One row per rank rather than a table per property, so a rank is read in one place instead of reassembled from
 * three lookups down a template — <Row>'s ROW_TIERS, one figure over.
 *
 * `gap` is here and not guessed at the call site because the unit sits on the VALUE's baseline: the space
 * between a 24px figure and an 11px unit is not the space between a 14px figure and the same unit, and the two
 * files that drew this by hand had already picked `gap-x-2` and `gap-x-1.5` for exactly that reason. */
export const VERDICT_RANKS = {
    lg: { value: `text-2xl leading-none font-semibold`, unit: `text-xs`, gap: `gap-x-2` },
    sm: { value: `text-sm font-semibold`, unit: `text-2xs`, gap: `gap-x-1.5` },
    xs: { value: `text-xs font-medium`, unit: `text-2xs`, gap: `gap-x-1.5` },
} as const satisfies Record<VerdictSize, Record<string, string>>;
