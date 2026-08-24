import { type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

export type IconRailSize = "compact" | "comfortable";

/* THE RAIL'S WIDTH, written down once. The shell draws the column at this many rem divided back out of the
 * text size (ShellDesktop's `rail()`, the rail is chrome and does not take the app's text size), which makes
 * it a constant number of SCREEN pixels: 56 compact, 64 comfortable. Anything that has to know how much of the
 * window the rail has already spent, the chat column's width clamp in useLayout is the one that does, reads
 * it from here rather than growing a second copy of the number to drift from. */
export const ICON_RAIL_WIDTH_REM: Record<IconRailSize, number> = { compact: 3.5, comfortable: 4 };
export const iconRailScreenPx = (size: IconRailSize): number => ICON_RAIL_WIDTH_REM[size] * 16;

const STORAGE_KEY = `ui-icon-rail-size`;

/* Owns the desktop icon rail's width and control spacing as an account preference
 * (composables/preference.ts), so every window of the app draws the same chrome. The shell reads the ref
 * directly, so switching sizes repaints live. Compact is the default because the rail should yield as much room
 * as possible to the workspace. */

const isIconRailSize = (value: unknown): value is IconRailSize => value === `compact` || value === `comfortable`;

const iconRailSize: Ref<IconRailSize> = definePreference<IconRailSize>({
    key: STORAGE_KEY,
    read: (raw) => (isIconRailSize(raw) ? raw : `compact`),
    write: (value) => value,
});

export function useIconRailSize() {
    return { iconRailSize };
}
