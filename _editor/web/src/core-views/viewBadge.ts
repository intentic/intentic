import type { ViewBadge } from "@intentic/extension-api";

// A PLATE IS THE TONE'S OWN INK, INVERTED — the four below are BADGE_INK painted rather than written, with the
// surface those inks were measured against as the label. Opaque, because a chip overlaps the glyph it badges and
// a wash reads as part of the drawing instead of as something laid on it: the 10–15% tints this replaces measured
// 1.2:1 against the tile, which is no plate and no tone. Inverting the ink rather than reaching for `*-fill` keeps
// a skin's own accent: every skin already tunes these four to be legible against its canvas, so the contrast comes
// with them, and the gold skin gets a gold badge instead of the app's orange.
const BADGE_TONE: Record<NonNullable<ViewBadge["tone"]>, string> = {
    neutral: `bg-muted text-canvas`,
    info: `bg-link text-canvas`,
    warning: `bg-warning text-canvas`,
    danger: `bg-danger text-canvas`,
};

// Absent tone defaults to the resting count, the tone every core surface leaves unset.
export const badgeClass = (badge: ViewBadge): string => BADGE_TONE[badge.tone ?? `info`];

// Same four volumes as ink alone, for a sentence-shaped badge (no fill, so length itself signals danger).
const BADGE_INK: Record<NonNullable<ViewBadge["tone"]>, string> = {
    neutral: `text-muted`,
    info: `text-link`,
    warning: `text-warning`,
    danger: `text-danger`,
};

export const badgeToneClass = (badge: ViewBadge): string => BADGE_INK[badge.tone ?? `info`];

// Shared "99+" cap, used by rail/mobile/hub alike: a product decision, not each surface's own rounding.
export const badgeText = ({ count = 0 }: ViewBadge): string => (count > 99 ? `99+` : String(count));

// Whether there is a chip to draw at all. A badge carrying only `running` has no number and no glyph for
// one — its mark is drawn beside the tile instead — and without this every surface would paint an empty
// plate, or a "0", over a tile whose only news is that something is moving.
export const badgeChip = (badge: ViewBadge): boolean => (badge.count ?? 0) > 0 || badge.mark !== undefined;

// Whether the badge says anything at all, chip or running mark. The registry normalizes on this, so a
// badge that fails it never reaches a surface and every caller can go on testing presence alone.
export const badgeSpeaks = (badge: ViewBadge): boolean => badgeChip(badge) || badge.running !== undefined;

// The turning mark's own ink: the app's one "in flight" colour, the same link blue a running agent's
// spinner wears (agentStatus.ts), so activity reads the same wherever it is drawn. Deliberately not a
// BADGE_TONE: a plate would make progress look like an errand, which is the whole thing it isn't.
export const RUNNING_MARK_CLASS = `text-link`;
