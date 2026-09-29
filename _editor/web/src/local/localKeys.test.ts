import "@intentic/testing/dom";
import { localChord } from "./localKeys";

// Pins the three chords a local window takes for itself, and that it takes nothing else: a key it leaves alone reaches
// the editor, the field or the tree that has focus.

const press = (key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent(`keydown`, { key, ...modifiers });

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
