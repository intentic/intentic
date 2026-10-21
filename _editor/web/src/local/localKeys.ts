import { matchesChord } from "../workbench/commands/keybindings";
import { builtinChord, type BuiltinCommand, SANDBOX_SWITCH_COMMANDS } from "../workbench/commands/builtinCommands";
import { effectiveKeybinding } from "../workbench/commands/useKeymap";

// The chords a local window answers itself. It has no command registry to bind them through (the workspace's keydown
// dispatcher, useKeybindings.ts, is the shell's), and it takes nothing else: every other key, typed in an editor or
// anywhere, goes on to whatever has focus.
export type LocalChord = `find-file` | `search-text` | `close-tab`;

// Each chord is the local face of a workspace command, named by that command's id so the person's keymap (Settings →
// Keyboard, useKeymap.ts) reaches this window too: a remap moves the chord here as well, an unbinding drops it. The
// binding beside it is the command's own default (builtinCommands.ts), used while it has no override, but for closing a
// tab, which is Mod+W here: a key the desktop window may take and a browser tab may not, where the workspace's default
// is Ctrl+Shift+X.
const CHORDS: readonly (readonly [command: BuiltinCommand, binding: string | undefined, chord: LocalChord])[] = [
    [`workspace.goToAnything`, builtinChord(`workspace.goToAnything`), `find-file`],
    [`workspace.searchContent`, builtinChord(`workspace.searchContent`), `search-text`],
    [`workspace.closeTab`, `Mod+W`, `close-tab`],
];

/** Which of the window's chords a keydown is, if any, after the person's keymap. `isMac` makes `Mod` Cmd rather than Ctrl. */
export const localChord = (event: KeyboardEvent, isMac: boolean): LocalChord | undefined =>
    CHORDS.find(([command, binding]) => {
        const chord = effectiveKeybinding(command, binding);
        return chord !== undefined && matchesChord(chord, event, isMac);
    })?.[2];

// Alt+1…9, as the workspace's sandbox switcher binds them (the same commands, so the same remaps): the Nth of the
// account's sandboxes, which a local window lists in the workspace's own order, so a digit is the same sandbox from
// either window. Alt+0 is this computer, where a local window already is, so it is not taken here.

/** The chord that picks the sandbox at `at`, as a binding (`Alt+3`) after the person's keymap; none past the ninth. */
export const sandboxSlotChord = (at: number): string | undefined => {
    const command = SANDBOX_SWITCH_COMMANDS[at];
    return command === undefined ? undefined : effectiveKeybinding(command, builtinChord(command));
};

/** Which sandbox (0 for the first) a keydown names, if it is one of the switcher's chords. */
export const sandboxSlot = (event: KeyboardEvent, isMac: boolean): number | undefined => {
    const at = SANDBOX_SWITCH_COMMANDS.findIndex((_command, slot) => {
        const chord = sandboxSlotChord(slot);
        return chord !== undefined && matchesChord(chord, event, isMac);
    });
    return at === -1 ? undefined : at;
};
