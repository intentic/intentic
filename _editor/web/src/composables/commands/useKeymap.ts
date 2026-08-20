import { ref } from "vue";

/* The user keymap: per-command chord OVERRIDES layered over each command's declared default. A developer expects to
 * remap shortcuts, the single biggest "familiar" gap once bindings exist, so this is the store that makes them
 * rebindable. It mirrors useLayout's client-preference idiom (a module-level singleton persisted to localStorage,
 * Storage-failure tolerant): a keymap is per-machine, exactly like VSCode's keybindings.json, so localStorage is the
 * honest home for it. The store is deliberately isolated behind `useKeymap` + `effectiveKeybinding`, so a later run
 * can promote it to daemon-synced settings (keymap-follows-you) by swapping only the read/write here.
 *
 * An entry maps a command id to either a chord string (remapped) or `null` (explicitly UNBOUND, the user removed
 * the default and wants no shortcut). A command ABSENT from the map keeps its declared default. That three-state
 * model (remapped / unbound / default) is what a real keymap needs and what `effectiveKeybinding` resolves. */

const STORAGE_KEY = `ui-keymap-overrides`;

type Overrides = Readonly<Record<string, string | null>>;

const read = (): Overrides => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === null) {
            return {};
        }
        const parsed: unknown = JSON.parse(stored);
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

const write = (value: Overrides): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds for this session.
    }
};

// Exported so the palette/dispatcher read it reactively and tests can seed it directly (the useCommands.test idiom).
export const keymapOverrides = ref<Overrides>(read());

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
    write(keymapOverrides.value);
};

// Explicitly remove a command's shortcut (distinct from reverting to its default).
const unbindKeybinding = (command: string): void => {
    keymapOverrides.value = { ...keymapOverrides.value, [command]: null };
    write(keymapOverrides.value);
};

// Drop the override so the command falls back to its declared default.
const resetKeybinding = (command: string): void => {
    const { [command]: _removed, ...rest } = keymapOverrides.value;
    keymapOverrides.value = rest;
    write(keymapOverrides.value);
};

// Clear every override, the whole keymap returns to declared defaults.
const resetKeymap = (): void => {
    keymapOverrides.value = {};
    write(keymapOverrides.value);
};

export function useKeymap() {
    return { overrides: keymapOverrides, effectiveKeybinding, setKeybinding, unbindKeybinding, resetKeybinding, resetKeymap };
}
