// <Verdict>'s tone and rank tables, kept as data so a measured answer's presentation isn't restated per caller (mirrors
// <Row>'s geometry in row.ts).

/**
 * What kind of answer this is: `success` only for an actually measured saving; "Measuring"/"Off" are `muted`, a
 * regression is `content`.
 */
export type VerdictTone = `success` | `content` | `muted`;

export const VERDICT_TONES = {
    success: `text-success`,
    content: `text-content`,
    muted: `text-muted`,
} as const satisfies Record<VerdictTone, string>;

// Rank the surface picks, not the caller's sense of importance:
// - `lg` a card's hero, the reason the card exists
// - `sm` a row's reading, one rank below the setting's own title
// - `xs` a second reading of the same subject, a footnote to the headline
// All ranks use tabular-nums, since live figures must not shift sideways as they update.
export type VerdictSize = `lg` | `sm` | `xs`;

// One row per rank, not a table per property, so a rank reads in one place; `gap` depends on the value's size.
export const VERDICT_RANKS = {
    lg: { value: `text-2xl leading-none font-semibold`, unit: `text-xs`, gap: `gap-x-2` },
    sm: { value: `text-sm font-semibold`, unit: `text-2xs`, gap: `gap-x-1.5` },
    xs: { value: `text-xs font-medium`, unit: `text-2xs`, gap: `gap-x-1.5` },
} as const satisfies Record<VerdictSize, Record<string, string>>;
