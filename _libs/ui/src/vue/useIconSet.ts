import { ref, watch, type Ref } from "vue";
import { iconSets, type IconSet } from "../icons/iconSets.js";

const STORAGE_KEY = `ui-icon-set`;

/* Owns the active icon set as a module-level singleton, mirroring useTheme. Unlike the theme it drives
 * no <html> attribute — the <Icon> component reads this ref directly, so switching sets repaints every
 * icon reactively. Persisted to localStorage; reads fall back to the default until a choice is stored. */

const isIconSet = (value: unknown): value is IconSet => iconSets.includes(value as IconSet);

const read = (): IconSet => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isIconSet(stored)) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
    }
    return `remix`;
};

const iconSet: Ref<IconSet> = ref(read());

// Persist every change (including direct writes from the Settings picker), so no page needs a setter.
watch(iconSet, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useIconSet() {
    return { iconSet, iconSets };
}
