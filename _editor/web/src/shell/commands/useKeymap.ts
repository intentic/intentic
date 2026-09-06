import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

/* The user keymap: per-command chord OVERRIDES layered over each command's declared default. A developer expects to
 * remap shortcuts, the single biggest "familiar" gap once bindings exist, so this is the store that makes them
 * rebindable. An account preference (composables/preference.ts), the same idiom useLayout's settings use: a keymap
 * is per-machine, exactly like VSCode's keybindings.json. Being a preference is what makes a rebind reach the
 * POPPED-OUT windows, which install the dispatcher for themselves (pages/FloatingArea.vue) and would otherwise
 * keep answering to yesterday's chords, including the F9 that docks them. The store is deliberately isolated
 * behind `useKeymap` + `effectiveKeybinding`, so a later run can promote it to daemon-synced settings
 * (keymap-follows-you) by swapping only the declaration here.
 *
 * An entry maps a command id to either a chord string (remapped) or `null` (explicitly UNBOUND, the user removed
 * the default and wants no shortcut). A command ABSENT from the map keeps its declared default. That three-state
 * model (remapped / unbound / default) is what a real keymap needs and what `effectiveKeybinding` resolves. */

const STORAGE_KEY = `ui-keymap-overrides`;

type Overrides = Readonly<Record<string, string | null>>;

const read = (raw: string | null): Overrides => {
    if (raw === null) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== `object` || parsed === null) {
            return {};
        }
        // Keep only well-typed entries (chord string or null); ignore anything a hand-edited/corrupt blob smuggled in.
        const clean: Record<string, string | null> = {};
        for (const [command, chord] of Object.entries(parsed as Record<string, unknown>)) {
            if (chord === null || typeof chord === `string`) {
                clean[command] = chord;
            }
        }
        return clean;
    } catch {
        return {};
    }
};

// Exported so the palette/dispatcher read it reactively and tests can seed it directly (the useCommands.test idiom).
export const keymapOverrides: Ref<Overrides> = definePreference<Overrides>({
    key: STORAGE_KEY,
    read,
    write: (value) => JSON.stringify(value),
});

// The command's active chord: an override wins over the declared default; a `null` override means "unbound" (no
// shortcut); no override falls through to `declared`. This is the ONE resolver the dispatcher and palette share.
export const effectiveKeybinding = (command: string, declared: string | undefined): string | undefined => {
    const override = keymapOverrides.value[command];
    if (override === undefined) {
        return declared;
    }
    return override ?? undefined;
};

// Remap a command to a new chord.
const setKeybinding = (command: string, chord: string): void => {
    keymapOverrides.value = { ...keymapOverrides.value, [command]: chord };
};

// Explicitly remove a command's shortcut (distinct from reverting to its default).
const unbindKeybinding = (command: string): void => {
    keymapOverrides.value = { ...keymapOverrides.value, [command]: null };
};

// Drop the override so the command falls back to its declared default.
const resetKeybinding = (command: string): void => {
    const { [command]: _removed, ...rest } = keymapOverrides.value;
    keymapOverrides.value = rest;
};

// Clear every override, the whole keymap returns to declared defaults.
const resetKeymap = (): void => {
    keymapOverrides.value = {};
};

export function useKeymap() {
    return { overrides: keymapOverrides, effectiveKeybinding, setKeybinding, unbindKeybinding, resetKeybinding, resetKeymap };
}
