import { ref, watch, type Ref } from "vue";

export type IconRailSize = "compact" | "comfortable";

/* THE RAIL'S WIDTH, written down once. The shell draws the column at this many rem divided back out of the
 * text size (ShellDesktop's `rail()` — the rail is chrome and does not take the app's text size), which makes
 * it a constant number of SCREEN pixels: 56 compact, 64 comfortable. Anything that has to know how much of the
 * window the rail has already spent — the chat column's width clamp in useLayout is the one that does — reads
 * it from here rather than growing a second copy of the number to drift from. */
export const ICON_RAIL_WIDTH_REM: Record<IconRailSize, number> = { compact: 3.5, comfortable: 4 };
export const iconRailScreenPx = (size: IconRailSize): number => ICON_RAIL_WIDTH_REM[size] * 16;

const STORAGE_KEY = `ui-icon-rail-size`;

/* Owns the desktop icon rail's width and control spacing as a module-level singleton. The shell reads the
 * ref directly, so switching sizes repaints the chrome live. Persisted to localStorage; compact is the
 * default because the rail should yield as much room as possible to the workspace. */

const isIconRailSize = (value: unknown): value is IconRailSize => value === `compact` || value === `comfortable`;

const read = (): IconRailSize => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isIconRailSize(stored)) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
    }
    return `compact`;
};

const iconRailSize: Ref<IconRailSize> = ref(read());

watch(iconRailSize, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useIconRailSize() {
    return { iconRailSize };
}
