import type { Disposable } from "@intentic/extension-api";
import { evaluateWhen, parseWhen, type WhenExpression } from "@intentic/base/when";
import { shallowRef } from "vue";
import { commandContext } from "./contextKeys";
import { formatChord, isApplePlatform, matchesChord } from "./keybindings";
import { effectiveKeybinding } from "./useKeymap";

// Command registry: extensions (and builtins) register commands here, surfaced in Quick Open's `>` mode and
// executable by id. A module-level singleton ref; every consumer reads the same reactive list.

export interface CommandRegistration {
    // "builtin" or the owning extension's id.
    readonly owner: string;
    readonly command: string;
    readonly title: string;
    readonly icon?: string | undefined;
    // Chord in keybindings.ts notation (e.g. "Mod+Shift+P"); undefined if reachable only from the palette.
    readonly keybinding?: string | undefined;
    // Gates the keybinding only: a contextKeys.ts condition; false leaves the keystroke to its current owner.
    readonly when?: string | undefined;
    readonly handler: (...args: unknown[]) => unknown;
}

// Registration plus its condition parsed once, here, not per keystroke; an unparseable condition throws at
// registration time.
export interface RegisteredCommand extends CommandRegistration {
    readonly gate: WhenExpression | undefined;
}

export const commands = shallowRef<readonly RegisteredCommand[]>([]);

export const registerCommand = (registration: CommandRegistration): Disposable => {
    if (commands.value.some((existing) => existing.command === registration.command)) {
        throw new Error(`command "${registration.command}" is already registered`);
    }
    // Descriptors, not a spread: some commands define `title` as a live getter (e.g. the chat pop-out).
    const entry = Object.defineProperties({} as RegisteredCommand, {
        ...Object.getOwnPropertyDescriptors(registration),
        gate: { value: registration.when === undefined ? undefined : parseWhen(registration.when), enumerable: true },
    });
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

// Command bound to a live keydown: matches the effective chord (remap ?? default), skips a closed `when` gate.
// Shared by the window dispatcher and terminal key-forwarding hook, so shell-owned chords can't drift.
export const boundCommand = (event: KeyboardEvent, isMac: boolean): RegisteredCommand | undefined => {
    // Built once per keystroke: resolving the focused surface walks the DOM, costly to repeat per candidate.
    const context = commandContext(event);
    return commands.value.find((entry) => {
        if (entry.gate !== undefined && !evaluateWhen(entry.gate, context)) {
            return false;
        }
        const chord = effectiveKeybinding(entry.command, entry.keybinding);
        return chord !== undefined && matchesChord(chord, event, isMac);
    });
};

// Formatted shortcut for a command: effective chord (override ?? default) via the platform formatter, or undefined
// if unbound. Reads registry and keymap reactively; platform is read per call to stay import-safe outside a DOM.
export const commandShortcut = (command: string): string | undefined => {
    const entry = commands.value.find((candidate) => candidate.command === command);
    if (entry === undefined) {
        return undefined;
    }
    const chord = effectiveKeybinding(command, entry.keybinding);
    return chord === undefined ? undefined : formatChord(chord, isApplePlatform());
};

// Appends a command's shortcut to a label, e.g. "New terminal (Ctrl+Shift+`)", for tooltips/aria-labels that
// duplicate a command's action.
export const withShortcut = (text: string, command: string): string => {
    const shortcut = commandShortcut(command);
    return shortcut === undefined ? text : `${text} (${shortcut})`;
};
