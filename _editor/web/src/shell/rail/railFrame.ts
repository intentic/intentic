import { ICON_RAIL_WIDTH_REM, type IconRailSize } from "../../workbench/window/useIconRailSize";

// The rail's measures as the custom properties its stylesheet reads (iconRail.css), for the shell to set on its grid: one
// table for every shell that draws a rail, so a tile in a window on a folder is the tile the sandbox shell draws. Rail
// measures divide out --ui-scale: chrome doesn't grow with the app's text size.
const rail = (value: string): string => `calc(${value} / var(--ui-scale))`;

export const railFrame = (size: IconRailSize) => {
    const compact = size === `compact`;
    return {
        "--icon-rail-width": rail(`${ICON_RAIL_WIDTH_REM[size]}rem`),
        "--icon-rail-tile-size": rail(compact ? `2.5rem` : `2.75rem`),
        "--icon-rail-account-size": rail(compact ? `2rem` : `2.25rem`),
        "--icon-rail-divider-width": rail(compact ? `1.75rem` : `2rem`),
        "--icon-rail-gap": rail(compact ? `0.375rem` : `0.5rem`),
        "--icon-rail-padding": rail(compact ? `0.5rem` : `0.75rem`),
        // Half the tile at both widths, so the glyph keeps the same air around it when the rail narrows.
        "--icon-rail-glyph-size": rail(compact ? `1.25rem` : `1.375rem`),
        // The type size every corner mark is drawn from: a 1.6em plate on the chip, a 1.1em glyph on a bare mark.
        "--icon-rail-mark-size": rail(`0.625rem`),
    };
};

// THE PHONE'S RAIL (MobileRail.vue): the same column at a finger's size rather than a pointer's. The width stays the
// comfortable desktop rail's, and the tiles take the room its padding held: 52px plates with 6px either side, glyphs
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
