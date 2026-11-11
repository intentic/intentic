import { ICON_RAIL_WIDTH_REM } from "../../workbench/window/iconRailWidth";

// The rail's measures as the custom properties its stylesheet reads (iconRail.css), for the shell to set on its grid: one
// table for every shell that draws a rail, so a tile in a window on a folder is the tile the sandbox shell draws. Rail
// measures divide out --ui-scale: chrome doesn't grow with the app's text size.
const rail = (value: string): string => `calc(${value} / var(--ui-scale))`;

export const railFrame = () => ({
    "--icon-rail-width": rail(`${ICON_RAIL_WIDTH_REM}rem`),
    "--icon-rail-tile-size": rail(`2.375rem`),
    "--icon-rail-account-size": rail(`2.25rem`),
    "--icon-rail-divider-width": rail(`2rem`),
    "--icon-rail-gap": rail(`0.5rem`),
    "--icon-rail-padding": rail(`0.75rem`),
    // A 20px glyph in the 38px tile: 9px of plate either side, enough to read as a tile without a slab of colour.
    "--icon-rail-glyph-size": rail(`1.25rem`),
    // The type size every corner mark is drawn from: a 1.6em plate on the chip, a 1.1em glyph on a bare mark.
    "--icon-rail-mark-size": rail(`0.625rem`),
});

// THE PHONE'S RAIL (MobileRail.vue): the same column at a finger's size rather than a pointer's. The width is the 64px
// the desktop rail once had, and the tiles take the room its padding held: 52px plates with 6px either side, glyphs
// 28px, since on a phone the icon is the whole label (no tooltip ever opens) and has to read at a glance.
export const phoneRailFrame = () => ({
    "--icon-rail-width": rail(`4rem`),
    "--icon-rail-tile-size": rail(`3.25rem`),
    "--icon-rail-account-size": rail(`2.75rem`),
    "--icon-rail-divider-width": rail(`2.25rem`),
    "--icon-rail-gap": rail(`0.25rem`),
    "--icon-rail-padding": rail(`0.5rem`),
    "--icon-rail-glyph-size": rail(`1.75rem`),
    "--icon-rail-mark-size": rail(`0.6875rem`),
});
