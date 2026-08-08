import { useTextSize } from "@intentic/ui/text-size";

/* TWO UNITS, AND THE TRIP BETWEEN THEM.
 *
 * Nearly all of this app is sized in rem, so the base text size (useTextSize) moves it for free. The exception
 * is a width the READER dragged: a column width is a number we store, and a pointer position is a number the
 * browser hands us, and neither is a rem.
 *
 * So those widths are held in APP PIXELS — pixels at the base text size, the ones every measured constant in
 * useLayout was written in. A column then keeps the same number of characters across text sizes, which is what
 * a reader who widened a column until the paths fit actually asked for. Screen pixels appear at exactly two
 * edges: the pointer, and anything handed to the platform (a pop-out window's size). Convert there, nowhere
 * else — a conversion in the middle is how a value ends up scaled twice.
 */

/** A stored width as CSS. Deliberately a `calc` rather than a number: the browser re-resolves it the instant the
 *  text size changes, so no column has to be recomputed or re-clamped when someone flips the setting. */
export const uiLength = (appPx: number): string => `calc(${appPx}px * var(--ui-scale))`;

/** For anything outside the stylesheet's reach, which only knows screen pixels: `window.open` sizing, and the
 *  two editors that paint their own text (Monaco, xterm) from a number rather than from CSS. Those are the
 *  surfaces that would otherwise sit at yesterday's size inside an app that grew around them — a diff in
 *  smaller type than the panel listing its files. */
export const toScreenPx = (appPx: number): number => Math.round(appPx * useTextSize().scale.value);

/** For the pointer: a drag arrives in screen pixels and is stored in app pixels. */
export const toAppPx = (screenPx: number): number => screenPx / useTextSize().scale.value;
