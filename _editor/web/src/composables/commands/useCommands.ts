import type { Disposable } from "@intentic/extension-api";
import { evaluateWhen, parseWhen, type WhenExpression } from "@intentic/base/when";
import { shallowRef } from "vue";
import { commandContext } from "./contextKeys";
import { formatChord, isApplePlatform, matchesChord } from "./keybindings";
import { effectiveKeybinding } from "./useKeymap";

/* The command registry: commands registered by extensions (and, opportunistically, builtins) surfaced in Quick
 * Open's `>` command mode and executable by id. A module-level singleton ref, like the extension registry,
 * every consumer reads the same reactive list. */

export interface CommandRegistration {
    // "builtin" or the owning extension's id.
    readonly owner: string;
    readonly command: string;
    readonly title: string;
    readonly icon?: string | undefined;
    // The keyboard chord that runs this command, in the notation `keybindings.ts` parses (e.g. "Mod+Shift+P");
    // undefined for commands reachable only from the palette. The shell's dispatcher (useKeybindings) reads it.
    readonly keybinding?: string | undefined;
    /* Gates the KEYBINDING only (palette execution ignores it): a condition over the shell's context keys
     * (`contextKeys.ts`), e.g. `tabSurface == 'chat'` or `agentsUndoable && !editableTarget`. False leaves the
     * keystroke with whatever owns it. Monaco's find widget, the shell in a terminal, the browser.
     *
     * A STRING rather than the predicate this used to take, because a predicate cannot be written down. An
     * extension declares its commands in JSON, so under the old shape extension commands could carry no
     * condition at all and every one of them was always bound; and the keybindings page could see that a
     * command was gated but never on what. Both surfaces read the same string now. */
    readonly when?: string | undefined;
    readonly handler: (...args: unknown[]) => unknown;
}

// What the registry holds: the registration plus its condition already parsed. Parsed ONCE here rather than
// per keystroke in `boundCommand`, and an unparseable condition throws at registration, for a builtin that is
// a bug in this repo and failing loudly is how it is found, and an extension's has already been refused by the
// manifest schema before it could reach this.
export interface RegisteredCommand extends CommandRegistration {
    readonly gate: WhenExpression | undefined;
}

export const commands = shallowRef<readonly RegisteredCommand[]>([]);

export const registerCommand = (registration: CommandRegistration): Disposable => {
    if (commands.value.some((existing) => existing.command === registration.command)) {
        throw new Error(`command "${registration.command}" is already registered`);
    }
    /* Descriptors rather than a spread. Two shell commands carry a GETTER for `title`, the chat pop-out
     * renames itself for the direction the next press will take, and a spread reads every property, which
     * would freeze both at whatever they said the moment the shell mounted. */
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

// The command a live keydown is bound to, matching the EFFECTIVE chord (user remap ?? declared default) and
// skipping commands whose `when` gate is closed. This is the ONE matching loop shared by the window dispatcher
// (which then executes the command) and the terminal's key-forwarding hook (which makes xterm ignore the key so
// it reaches the dispatcher), sharing it means "which chords are shell-owned" can never drift between the two.
export const boundCommand = (event: KeyboardEvent, isMac: boolean): RegisteredCommand | undefined => {
    // Built once per keystroke, not once per candidate: resolving the focused surface walks the DOM, and doing
    // that inside the find would repeat it for every registered command the chord does not match.
    const context = commandContext(event);
    return commands.value.find((entry) => {
        if (entry.gate !== undefined && !evaluateWhen(entry.gate, context)) {
            return false;
        }
        const chord = effectiveKeybinding(entry.command, entry.keybinding);
        return chord !== undefined && matchesChord(chord, event, isMac);
    });
};

// The formatted shortcut label for a registered command, its EFFECTIVE chord (user override ?? declared
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

// A label that also teaches its shortcut, "New terminal (Ctrl+Shift+`)" when the command is bound, the plain
// text otherwise. Tooltips and aria-labels on buttons that DUPLICATE a command call this, so the control the
// pointer finds is what teaches the key the hand should learn instead.
export const withShortcut = (text: string, command: string): string => {
    const shortcut = commandShortcut(command);
    return shortcut === undefined ? text : `${text} (${shortcut})`;
};
