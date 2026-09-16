import type { ViewBadge } from "@intentic/extension-api";
// The subpath, never the kit's barrel: this module is read by DOM-free callers (registry.test.ts runs in node) and
// the barrel pulls in useTheme, which touches `document` at import.
import { countBadgePlate, countBadgeText } from "@intentic/ui/count-badge";

// The plate itself lives in the kit (`components/feedback/countBadge.ts`), since a SegmentedControl option draws the
// same count and the two had drifted into two looks for one number. What stays here is the mapping from the
// extension API's own badge shape onto it.

// Absent tone defaults to the resting count, the tone every core surface leaves unset.
export const badgeClass = (badge: ViewBadge): string => countBadgePlate(badge.tone);

// Same four volumes as ink alone, for a sentence-shaped badge (no fill, so length itself signals danger).
const BADGE_INK: Record<NonNullable<ViewBadge["tone"]>, string> = {
    neutral: `text-muted`,
    info: `text-link`,
    warning: `text-warning`,
    danger: `text-danger`,
};

export const badgeToneClass = (badge: ViewBadge): string => BADGE_INK[badge.tone ?? `info`];

// Shared "99+" cap, used by rail/mobile/hub alike: a product decision, not each surface's own rounding.
export const badgeText = ({ count }: ViewBadge): string => countBadgeText(count);

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
