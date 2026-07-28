import { ref, watch, type Ref } from "vue";

export type IconRailSize = "compact" | "comfortable";

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
