import type { Disposable } from "@intentic/extension-api";
import { shallowRef } from "vue";
import { formatChord, isApplePlatform, matchesChord } from "./keybindings";
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
    // Gates the KEYBINDING only (palette execution ignores it) — VSCode's `when` clause reduced to a predicate
    // over the live keydown. Returning false leaves the keystroke with whatever owns it: Monaco's find widget,
    // the shell in a terminal, the browser. Evaluated by `boundCommand`, which both dispatch sites share.
    readonly when?: ((event: KeyboardEvent) => boolean) | undefined;
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

// The command a live keydown is bound to — matching the EFFECTIVE chord (user remap ?? declared default) and
// skipping commands whose `when` gate is closed. This is the ONE matching loop shared by the window dispatcher
// (which then executes the command) and the terminal's key-forwarding hook (which makes xterm ignore the key so
// it reaches the dispatcher) — sharing it means "which chords are shell-owned" can never drift between the two.
export const boundCommand = (event: KeyboardEvent, isMac: boolean): RegisteredCommand | undefined =>
    commands.value.find((entry) => {
        if (entry.when !== undefined && !entry.when(event)) {
            return false;
        }
        const chord = effectiveKeybinding(entry.command, entry.keybinding);
        return chord !== undefined && matchesChord(chord, event, isMac);
    });

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

// A label that also teaches its shortcut — "New terminal (Ctrl+Shift+`)" when the command is bound, the plain
// text otherwise. Tooltips and aria-labels on buttons that DUPLICATE a command call this, so the control the
// pointer finds is what teaches the key the hand should learn instead.
export const withShortcut = (text: string, command: string): string => {
    const shortcut = commandShortcut(command);
    return shortcut === undefined ? text : `${text} (${shortcut})`;
};
