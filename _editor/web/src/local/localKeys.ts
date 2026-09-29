import { matchesChord } from "../shell/commands/keybindings";

// The chords a local window answers itself. It has no command registry to bind them through (the workspace's keydown
// dispatcher, useKeybindings.ts, is the shell's), and it takes nothing else: every other key, typed in an editor or
// anywhere, goes on to whatever has focus.
export type LocalChord = `find-file` | `search-text` | `close-tab`;

const CHORDS: readonly (readonly [binding: string, chord: LocalChord])[] = [
    [`Mod+P`, `find-file`],
    [`Mod+Shift+F`, `search-text`],
    [`Mod+W`, `close-tab`],
];

/** Which of the window's chords a keydown is, if any. `isMac` makes `Mod` Cmd rather than Ctrl. */
export const localChord = (event: KeyboardEvent, isMac: boolean): LocalChord | undefined =>
    CHORDS.find(([binding]) => matchesChord(binding, event, isMac))?.[1];
