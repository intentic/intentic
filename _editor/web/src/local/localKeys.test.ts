import "@intentic/testing/dom";
import { keymapOverrides } from "../workbench/commands/useKeymap";
import { localChord, sandboxSlot, sandboxSlotChord } from "./localKeys";

// Pins the three chords a local window takes for itself, and that it takes nothing else: a key it leaves alone reaches
// the editor, the field or the tree that has focus.

const press = (key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent(`keydown`, { key, ...modifiers });

afterEach(() => {
    keymapOverrides.value = {};
});

test("Ctrl finds a file, searches the folder's text and closes the tab off a Mac, and Cmd does on one", () => {
    expect([
        localChord(press(`p`, { ctrlKey: true }), false),
        localChord(press(`F`, { ctrlKey: true, shiftKey: true }), false),
        localChord(press(`w`, { ctrlKey: true }), false),
        localChord(press(`p`, { metaKey: true }), true),
        localChord(press(`F`, { metaKey: true, shiftKey: true }), true),
        localChord(press(`w`, { metaKey: true }), true),
    ]).toEqual([`find-file`, `search-text`, `close-tab`, `find-file`, `search-text`, `close-tab`]);
});

test("every other key is left to whatever has focus", () => {
    const passed = [
        press(`p`),
        press(`p`, { ctrlKey: true, shiftKey: true }),
        press(`f`, { ctrlKey: true }),
        press(`w`, { ctrlKey: true, altKey: true }),
        press(`s`, { ctrlKey: true }),
        press(`z`, { ctrlKey: true }),
    ].map((event) => localChord(event, false));
    // Cmd on a Mac is the chord; Ctrl there is somebody else's.
    expect([...passed, localChord(press(`p`, { ctrlKey: true }), true)]).toEqual(Array.from({ length: passed.length + 1 }, () => undefined));
});

// The workspace's Alt+1…9, so the same digit is the same sandbox from a local window. On a Mac, Option+1 types "¡", so
// the physical key is what names the digit there.
test("Alt and a digit name the sandbox in that place, the same on a Mac, and Alt+0 is not taken", () => {
    const digit = (n: number, key = `${n}`): KeyboardEvent => press(key, { altKey: true, code: `Digit${n}` });
    expect([sandboxSlot(digit(1), false), sandboxSlot(digit(9), false), sandboxSlot(digit(1, `¡`), true), sandboxSlot(digit(0), false)]).toEqual([
        0,
        8,
        0,
        undefined,
    ]);
    // A digit alone, or with another modifier, is somebody else's.
    expect([sandboxSlot(press(`1`, { code: `Digit1` }), false), sandboxSlot(press(`1`, { altKey: true, ctrlKey: true, code: `Digit1` }), false)]).toEqual([
        undefined,
        undefined,
    ]);
    expect([sandboxSlotChord(0), sandboxSlotChord(8), sandboxSlotChord(9)]).toEqual([`Alt+1`, `Alt+9`, undefined]);
});

// The person's keymap is the account's, so a chord remapped in Settings is remapped here too: the new chord does the
// job and the default is left to whatever has focus. Unbinding a command takes its chord out of this window as well.
test("a chord remapped in Settings is honoured here, and the default it replaced no longer fires", () => {
    keymapOverrides.value = { "workspace.goToAnything": `Mod+Shift+O`, "workspace.closeTab": `Mod+Alt+W`, "workspace.searchContent": null };
    expect([
        localChord(press(`O`, { ctrlKey: true, shiftKey: true }), false),
        localChord(press(`w`, { ctrlKey: true, altKey: true }), false),
        localChord(press(`p`, { ctrlKey: true }), false),
        localChord(press(`w`, { ctrlKey: true }), false),
        localChord(press(`F`, { ctrlKey: true, shiftKey: true }), false),
    ]).toEqual([`find-file`, `close-tab`, undefined, undefined, undefined]);
});
