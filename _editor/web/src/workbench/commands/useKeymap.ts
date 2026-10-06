import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

// User keymap: per-command chord overrides layered over each command's declared default, stored as an account
// preference (per-machine, like VSCode's keybindings.json) so popped-out windows pick it up too. An entry is a
// chord string (remapped), `null` (unbound), or absent (default); `effectiveKeybinding` resolves the three states.

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
        // Keep only well-typed entries (chord string or null); drop anything else.
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

// Exported so callers read it reactively and tests can seed it directly.
export const keymapOverrides: Ref<Overrides> = definePreference<Overrides>({
    key: STORAGE_KEY,
    read,
    write: (value) => JSON.stringify(value),
});

// Command's active chord: an override wins over the declared default, `null` means unbound, no entry falls through
// to declared. The one resolver the dispatcher and palette share.
export const effectiveKeybinding = (command: string, declared: string | undefined): string | undefined => {
    const override = keymapOverrides.value[command];
    if (override === undefined) {
        return declared;
    }
    return override ?? undefined;
};

const setKeybinding = (command: string, chord: string): void => {
    keymapOverrides.value = { ...keymapOverrides.value, [command]: chord };
};

// Sets an explicit `null`: no shortcut, distinct from falling back to the default.
const unbindKeybinding = (command: string): void => {
    keymapOverrides.value = { ...keymapOverrides.value, [command]: null };
};

// Removes the override entirely, falling back to the declared default.
const resetKeybinding = (command: string): void => {
    const { [command]: _removed, ...rest } = keymapOverrides.value;
    keymapOverrides.value = rest;
};

// Clears all overrides at once.
const resetKeymap = (): void => {
    keymapOverrides.value = {};
};

export function useKeymap() {
    return { overrides: keymapOverrides, effectiveKeybinding, setKeybinding, unbindKeybinding, resetKeybinding, resetKeymap };
}
