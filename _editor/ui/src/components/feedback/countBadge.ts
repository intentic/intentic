// The count chip every surface draws the same way: the rail's tile badge, the phone tab bar's, and a
// SegmentedControl option's. One table, because two of them drifted — the rail was moved to opaque plates and the
// segmented pill kept the 10–15% tint the plates replaced, so the same number wore two looks on one screen.

export type CountBadgeTone = "neutral" | "info" | "warning" | "danger";

// A PLATE IS THE TONE'S OWN INK, INVERTED — painted rather than written, with the surface those inks were measured
// against as the label. Opaque, because a wash reads as part of whatever it sits on instead of as something laid on
// it: the tints this replaces measured 1.2:1 against a rail tile, which is no plate and no tone. Inverting the ink
// rather than reaching for `*-fill` keeps a skin's own accent: every skin tunes these four to be legible against its
// canvas, so the contrast comes with them, and the gold skin gets a gold badge instead of the app's orange.
const PLATE: Record<CountBadgeTone, string> = {
    neutral: `bg-muted text-canvas`,
    info: `bg-link text-canvas`,
    warning: `bg-warning text-canvas`,
    danger: `bg-danger text-canvas`,
};

/** An unset tone is the resting count, which is what every core surface leaves it as. */
export const countBadgePlate = (tone: CountBadgeTone = `info`): string => PLATE[tone];

// The "99+" cap, shared rather than per surface: a product decision about how big a number is worth reading, not
// each caller's own rounding.
export const countBadgeText = (count = 0): string => (count > 99 ? `99+` : String(count));
