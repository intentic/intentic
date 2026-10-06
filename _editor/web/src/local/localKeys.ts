import { matchesChord } from "../workbench/commands/keybindings";
import { effectiveKeybinding } from "../workbench/commands/useKeymap";

// The chords a local window answers itself. It has no command registry to bind them through (the workspace's keydown
// dispatcher, useKeybindings.ts, is the shell's), and it takes nothing else: every other key, typed in an editor or
// anywhere, goes on to whatever has focus.
export type LocalChord = `find-file` | `search-text` | `close-tab`;

// Each chord is the local face of a workspace command, named by that command's id so the person's keymap (Settings →
// Keyboard, useKeymap.ts) reaches this window too: a remap moves the chord here as well, an unbinding drops it. The
// binding beside it is this window's own default, used while the command has no override; closing a tab is Mod+W here,
// a key the desktop window may take and a browser tab may not, where the workspace's default is Ctrl+Shift+X.
const CHORDS: readonly (readonly [command: string, binding: string, chord: LocalChord])[] = [
    [`workspace.goToAnything`, `Mod+P`, `find-file`],
    [`workspace.searchContent`, `Mod+Shift+F`, `search-text`],
    [`workspace.closeTab`, `Mod+W`, `close-tab`],
];

/** Which of the window's chords a keydown is, if any, after the person's keymap. `isMac` makes `Mod` Cmd rather than Ctrl. */
export const localChord = (event: KeyboardEvent, isMac: boolean): LocalChord | undefined =>
    CHORDS.find(([command, binding]) => {
        const chord = effectiveKeybinding(command, binding);
        return chord !== undefined && matchesChord(chord, event, isMac);
    })?.[2];

// Alt+1…9, as the workspace's sandbox switcher binds them: the Nth of the account's sandboxes, which a local window
// lists in the workspace's own order, so a digit is the same sandbox from either window. Alt+0 is this computer, where
// a local window already is, so it is not taken here.
const SANDBOX_SLOTS: readonly string[] = Array.from({ length: 9 }, (_, at) => `Alt+${at + 1}`);

/** Which sandbox (0 for the first) an Alt+digit keydown names, if it is one. */
export const sandboxSlot = (event: KeyboardEvent, isMac: boolean): number | undefined => {
    const at = SANDBOX_SLOTS.findIndex((binding) => matchesChord(binding, event, isMac));
    return at === -1 ? undefined : at;
};

/** The chord that picks the sandbox at `at`, as a binding (`Alt+3`); none past the ninth. */
export const sandboxSlotChord = (at: number): string | undefined => SANDBOX_SLOTS[at];
