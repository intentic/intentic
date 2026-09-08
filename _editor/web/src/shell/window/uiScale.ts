import { useTextSize } from "@intentic/ui/text-size";

// Most of this app is sized in rem; reader-set widths (a dragged column) and useLayout's constants are held in app
// pixels, pixels at the base text size, so a column keeps its character count across text sizes. Screen pixels appear
// only at the pointer and at the platform boundary (window.open sizing); convert only there.

/**
 * A stored width as CSS `calc()`, not a plain number, so the browser re-resolves it when the text size changes without
 * recomputation.
 */
export const uiLength = (appPx: number): string => `calc(${appPx}px * var(--ui-scale))`;

/**
 * For surfaces outside the stylesheet: window.open sizing, and canvas-based editors (Monaco, xterm) that paint text
 * from a number rather than CSS.
 */
export const toScreenPx = (appPx: number): number => Math.round(appPx * useTextSize().scale.value);

/** For the pointer: a drag arrives in screen pixels and is stored in app pixels. */
export const toAppPx = (screenPx: number): number => screenPx / useTextSize().scale.value;
