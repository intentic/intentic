import type { Disposable } from "@intentic/extension-api";
import { shallowRef } from "vue";
import { formatChord, isApplePlatform } from "./keybindings";
import { effectiveKeybinding } from "./useKeymap";

/* The command registry: commands registered by extensions (and, opportunistically, builtins) surfaced in Quick
 * Open's `>` command mode and executable by id. A module-level singleton ref, like the extension registry —
 * every consumer reads the same reactive list. */

export interface RegisteredCommand {
    // "builtin" or the owning extension's id.
    readonly owner: string;
    readonly command: string;
    readonly title: string;
    readonly icon?: string | undefined;
    // The keyboard chord that runs this command, in the notation `keybindings.ts` parses (e.g. "Mod+Shift+P");
    // undefined for commands reachable only from the palette. The shell's dispatcher (useKeybindings) reads it.
    readonly keybinding?: string | undefined;
    readonly handler: (...args: unknown[]) => unknown;
}

export const commands = shallowRef<readonly RegisteredCommand[]>([]);

export const registerCommand = (entry: RegisteredCommand): Disposable => {
    if (commands.value.some((existing) => existing.command === entry.command)) {
        throw new Error(`command "${entry.command}" is already registered`);
    }
    commands.value = [...commands.value, entry];
    return {
        dispose: (): void => {
            commands.value = commands.value.filter((existing) => existing !== entry);
        },
    };
};

export const executeCommand = async (command: string, ...args: unknown[]): Promise<unknown> => {
    const found = commands.value.find((entry) => entry.command === command);
    if (found === undefined) {
        throw new Error(`no command "${command}" is registered`);
    }
    return await found.handler(...args);
};

// The formatted shortcut label for a registered command — its EFFECTIVE chord (user override ?? declared
// default) run through the platform-native formatter (⇧⌘P vs Ctrl+Shift+P), or undefined when it has no
// binding / isn't registered. Menus and tooltips call this so a discoverable action also teaches its key; it
// reads the registry and keymap reactively, so a live remap re-renders the hint. Platform is read per call
// (cheap) rather than at module load, to keep this import-safe in non-DOM test setups.
export const commandShortcut = (command: string): string | undefined => {
    const entry = commands.value.find((candidate) => candidate.command === command);
    if (entry === undefined) {
        return undefined;
    }
    const chord = effectiveKeybinding(command, entry.keybinding);
    return chord === undefined ? undefined : formatChord(chord, isApplePlatform());
};
