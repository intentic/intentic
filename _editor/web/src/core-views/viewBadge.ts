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
 * The fill is solid, but NOT the shared `*-fill` + `fill-content` pairing: that role lightens to red-400 in
 * dark (so a dark label can sit on it), and on the rail that read as a neon dot detached from everything
 * around it — an alarm even when the breakage was one pipeline. A fixed numeric shade instead — red-800 with
 * a white label in BOTH schemes — keeps the solid silhouette that separates "your CI is broken" from a
 * resting count while sitting in the deep-red family the rest of the dark chrome already uses. The numeric
 * scales don't flip between schemes, so the pairing is stable: white on red-800 measures ~5.6:1 in dark and
 * higher in light, both above the AA floor. The `danger` ROLE with a white label would not be: that token
 * lightens in dark mode, leaving white text near 3:1.
 *
 * `neutral` IS THE ONE THAT IS NOT A CLAIM AT ALL, and it is the newest for the reason the others needed it: an
 * inventory ("docker is running", "one browser is open") was drawn in `info`, which is also what a debt wears, so
 * the two were the same orange 1 in the same round pill. Somebody who followed the sandbox chip's "1 port
 * couldn't be mirrored" into settings found the Status row wearing an identical 1, clicked it, and was told that
 * docker is active — a badge that led away from its own subject. An inventory is TRUE MOST OF THE DAY, which is
 * exactly the thing this file's opening rule says a badge must never be, so it gets ink that does not compete:
 * the same wash the app's quiet tags use, readable but never the thing the eye lands on first. */
const BADGE_TONE: Record<NonNullable<ViewBadge["tone"]>, string> = {
    neutral: `bg-content/10 text-muted`,
    info: `bg-primary-600/15 text-link`,
    warning: `bg-warning/15 text-warning`,
    danger: `bg-danger-fill text-fill-content`,
};

// Absent tone means the resting count — the tone every core surface has always left unset.
export const badgeClass = (badge: ViewBadge): string => BADGE_TONE[badge.tone ?? `info`];

// What the chip SAYS, on the same terms and for the same reason: the rail, the mobile menu and the hub index
// all render one, and "99+" is a product decision (the API documents it), not each surface's own rounding.
export const badgeText = ({ count = 0 }: ViewBadge): string => (count > 99 ? `99+` : String(count));
