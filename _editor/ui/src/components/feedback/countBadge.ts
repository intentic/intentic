import { tonePlate } from "../../lib/tone.js";

// The count chip every surface draws the same way: the rail's tile badge, the phone tab bar's, and a
// SegmentedControl option's. One table, because two of them drifted — the rail was moved to opaque plates and the
// segmented pill kept the 10–15% tint the plates replaced, so the same number wore two looks on one screen.

export type CountBadgeTone = "neutral" | "info" | "warning" | "danger";

// A plate is the tone's own ink inverted, opaque (tone.ts says why). An unset tone is the resting count, which is
// what every core surface leaves it as.
export const countBadgePlate = (tone: CountBadgeTone = `info`): string => tonePlate(tone);

// The "99+" cap, shared rather than per surface: a product decision about how big a number is worth reading, not
// each caller's own rounding.
export const countBadgeText = (count = 0): string => (count > 99 ? `99+` : String(count));
