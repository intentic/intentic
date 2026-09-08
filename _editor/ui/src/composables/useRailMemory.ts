import { type Ref, watch } from "vue";

// Remembers a narrowing rail's last choice in localStorage and restores it once, the first time `options` is
// non-empty, only if the URL has no choice of its own and the remembered value is still in `options`.

const keyOf = (id: string): string => `intentic.rail.${id}`;

// `` and undefined both mean unnarrowed (a Picker has no undefined to offer).
const isEmpty = (value: string | undefined): boolean => value === undefined || value === ``;

const read = (id: string): string | undefined => {
    try {
        return localStorage.getItem(keyOf(id)) ?? undefined;
    } catch {
        // Storage may be unavailable (private mode); the rail opens on its default.
        return undefined;
    }
};

/**
 * Remember a narrowing rail's choice and restore it the next time its view opens without one.
 * `options` arrives reactively after mount; the restore waits for a non-empty list rather than running on mount.
 */
export function useRailMemory(id: string, choice: Ref<string | undefined>, options: () => readonly string[]): void {
    // Persists "all" too, so a deliberately widened scope stays wide next visit.
    watch(choice, (value) => {
        try {
            localStorage.setItem(keyOf(id), value ?? ``);
        } catch {
            // Storage may be unavailable; the choice still holds for this visit.
        }
    });

    // Restores once, on the first non-empty options list; after that the reader is in control.
    let restored = false;
    watch(
        options,
        (values) => {
            if (restored || values.length === 0) {
                return;
            }
            restored = true;
            const held = read(id);
            // Nothing to restore when the last visit ended on "all"; that's already the default.
            if (isEmpty(choice.value) && !isEmpty(held) && held !== undefined && values.includes(held)) {
                choice.value = held;
            }
        },
        { immediate: true },
    );
}
