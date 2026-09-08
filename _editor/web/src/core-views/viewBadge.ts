import type { ViewBadge } from "@intentic/extension-api";

// Solid fill, not the shared *-fill token: that lightens in dark mode and fails contrast for the white label.
const BADGE_TONE: Record<NonNullable<ViewBadge["tone"]>, string> = {
    neutral: `bg-content/10 text-muted`,
    info: `bg-primary-600/15 text-link`,
    warning: `bg-warning/15 text-warning`,
    danger: `bg-danger-800 text-white`,
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
