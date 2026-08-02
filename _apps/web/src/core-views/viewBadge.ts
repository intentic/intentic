import type { ViewBadge } from "@intentic/extension-api";

/* HOW LOUD A TILE'S BADGE IS. One table, because the desktop rail and the mobile menu both render `ViewBadge`
 * and a tone that looked like an alarm on one surface and a resting count on the other would be the same fact
 * told two ways — the drift the registry's ordering table already exists to prevent.
 *
 * THE TONES ARE THREE VOLUMES, NOT THREE HUES. They used to be three 15% washes that differed only in colour.
 * Composited over the rail and measured, the danger chip and the info chip sat at 1.03:1 luminance contrast in
 * dark and 1.08:1 in light — LUMINANCE-IDENTICAL. Hue was not the main signal separating "your CI is broken"
 * from "3 uncommitted changes"; it was the only one. Anyone with red-green colour deficiency, on a poor panel,
 * or in sunlight had no signal at all. Solid fill puts that separation at 5.08:1 (dark) / 5.49:1 (light), which
 * survives with the colour thrown away.
 *
 * It matters for `danger` specifically because of WHAT SHAPE each tone arrives in. Almost every badge in the
 * rail is an `info` count. The one `warning` is a glyph (Deployments' "can't reach Komodo"), so it already reads
 * as different without any colour. `danger` is a bare COUNT — ext-pipelines' unacknowledged CI breakages, the
 * only claimant in the app — so it was a small number sitting exactly where every other small number sits.
 *
 * The old wash also FAILED WCAG AA outright in light mode: danger-600 text on a 15% danger wash measured
 * 3.67:1 against the 4.5:1 floor (dark scraped by at 4.95:1). So this is a contrast fix, not only a loudness one.
 *
 * `*-fill` + `fill-content` is the pairing built for exactly this. Each scheme picks the fill and the label that
 * sits on it TOGETHER (danger-700 on white in light, danger-400 on surface-900 in dark) and those values carry a
 * WCAG AA contract when used solid — measured 6.64:1 light, 6.25:1 dark. A hand-picked `bg-danger text-white`
 * would not: the `danger` role token LIGHTENS in dark mode (red-400), leaving white text near 3:1. */
const BADGE_TONE: Record<NonNullable<ViewBadge["tone"]>, string> = {
    info: `bg-primary-600/15 text-link`,
    warning: `bg-warning/15 text-warning`,
    danger: `bg-danger-fill text-fill-content`,
};

// Absent tone means the resting count — the tone every core surface has always left unset.
export const badgeClass = (badge: ViewBadge): string => BADGE_TONE[badge.tone ?? `info`];

// What the chip SAYS, on the same terms and for the same reason: the rail, the mobile menu and the hub index
// all render one, and "99+" is a product decision (the API documents it), not each surface's own rounding.
export const badgeText = ({ count = 0 }: ViewBadge): string => (count > 99 ? `99+` : String(count));
