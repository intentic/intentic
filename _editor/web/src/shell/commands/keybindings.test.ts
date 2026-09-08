import { describe, expect, it } from "vitest";
import { chordFromEvent, formatChord, matchesChord } from "./keybindings";

// Pins the keymap's two invariants: `Mod` resolves to the right physical key per platform, and
// modifiers must match exactly, so Mod+P never fires on Mod+Shift+P.

// A minimal stub: matchesChord reads only the modifier flags and `key`, defaulted to false.
const keydown = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

describe(`matchesChord`, () => {
    it(`resolves Mod to Cmd on Apple and Ctrl elsewhere`, () => {
        expect(matchesChord(`Mod+P`, keydown({ key: `p`, metaKey: true }), true)).toBe(true);
        expect(matchesChord(`Mod+P`, keydown({ key: `p`, ctrlKey: true }), true)).toBe(false);
        expect(matchesChord(`Mod+P`, keydown({ key: `p`, ctrlKey: true }), false)).toBe(true);
        expect(matchesChord(`Mod+P`, keydown({ key: `p`, metaKey: true }), false)).toBe(false);
    });

    it(`matches modifiers exactly so Mod+P does not fire on Mod+Shift+P`, () => {
        expect(matchesChord(`Mod+P`, keydown({ key: `P`, ctrlKey: true, shiftKey: true }), false)).toBe(false);
        expect(matchesChord(`Mod+Shift+P`, keydown({ key: `P`, ctrlKey: true, shiftKey: true }), false)).toBe(true);
    });

    it(`treats literal Ctrl the same on every platform and is case-insensitive on the key`, () => {
        expect(matchesChord(`Ctrl+\``, keydown({ key: `\``, ctrlKey: true }), true)).toBe(true);
        expect(matchesChord(`Ctrl+\``, keydown({ key: `\``, ctrlKey: true }), false)).toBe(true);
        // A bare Ctrl+` must not tolerate Cmd being held too.
        expect(matchesChord(`Ctrl+\``, keydown({ key: `\``, ctrlKey: true, metaKey: true }), true)).toBe(false);
    });

    it(`understands key aliases`, () => {
        expect(matchesChord(`Mod+Enter`, keydown({ key: `Enter`, metaKey: true }), true)).toBe(true);
        expect(matchesChord(`Esc`, keydown({ key: `Escape` }), false)).toBe(true);
    });

    it(`matches number/punctuation chords by physical key, so a Shift glyph or dead-key layout can't break them`, () => {
        // Under Shift, Backquote reports "~" or "Dead" (accent layouts); the physical code matches either way.
        expect(matchesChord(`Ctrl+Shift+\``, keydown({ key: `~`, code: `Backquote`, ctrlKey: true, shiftKey: true }), false)).toBe(true);
        expect(matchesChord(`Ctrl+Shift+\``, keydown({ key: `Dead`, code: `Backquote`, ctrlKey: true, shiftKey: true }), false)).toBe(true);
        // Digit5 reports "%" under Shift; matched by physical key regardless.
        expect(matchesChord(`Ctrl+Shift+5`, keydown({ key: `%`, code: `Digit5`, ctrlKey: true, shiftKey: true }), false)).toBe(true);
        // Still modifier-exact: Ctrl+` must not fire on Ctrl+Shift+`.
        expect(matchesChord(`Ctrl+\``, keydown({ key: `~`, code: `Backquote`, ctrlKey: true, shiftKey: true }), false)).toBe(false);
    });

    it(`carries Alt+digit through the glyphs Option composes on Apple layouts`, () => {
        // Option+digit composes accented characters on Apple, so this must match by physical key, not glyph.
        expect(matchesChord(`Alt+1`, keydown({ key: `¡`, code: `Digit1`, altKey: true }), true)).toBe(true);
        expect(matchesChord(`Alt+3`, keydown({ key: `£`, code: `Digit3`, altKey: true }), true)).toBe(true);
        // The same chord string still matches the plain digit elsewhere.
        expect(matchesChord(`Alt+1`, keydown({ key: `1`, code: `Digit1`, altKey: true }), false)).toBe(true);
        // Modifier-exact: adding Shift must not still match Alt+1.
        expect(matchesChord(`Alt+1`, keydown({ key: `¡`, code: `Digit1`, altKey: true, shiftKey: true }), true)).toBe(false);
    });
});

describe(`chordFromEvent`, () => {
    it(`records the primary modifier as portable Mod on each platform`, () => {
        expect(chordFromEvent(keydown({ key: `k`, metaKey: true }), true)).toBe(`Mod+k`);
        expect(chordFromEvent(keydown({ key: `k`, ctrlKey: true }), false)).toBe(`Mod+k`);
        expect(chordFromEvent(keydown({ key: `P`, ctrlKey: true, shiftKey: true }), false)).toBe(`Mod+Shift+p`);
    });

    it(`keeps a literal Control distinct from Mod on Apple`, () => {
        expect(chordFromEvent(keydown({ key: `\``, ctrlKey: true }), true)).toBe(`Ctrl+\``);
    });

    it(`round-trips through matchesChord`, () => {
        const chord = chordFromEvent(keydown({ key: `j`, metaKey: true, altKey: true }), true);
        expect(chord).toEqual(expect.any(String));
        expect(matchesChord(chord!, keydown({ key: `j`, metaKey: true, altKey: true }), true)).toBe(true);
    });

    it(`rejects a lone modifier and a modifier-less non-function key`, () => {
        expect(chordFromEvent(keydown({ key: `Meta`, metaKey: true }), true)).toBeUndefined();
        expect(chordFromEvent(keydown({ key: `a` }), true)).toBeUndefined();
        // Shift alone is not enough: a bare Shift+letter is still typing.
        expect(chordFromEvent(keydown({ key: `A`, shiftKey: true }), true)).toBeUndefined();
    });

    it(`allows a bare function key`, () => {
        expect(chordFromEvent(keydown({ key: `F5` }), false)).toBe(`f5`);
    });

    it(`records number/punctuation keys by physical base character, not the Shift glyph`, () => {
        expect(chordFromEvent(keydown({ key: `%`, code: `Digit5`, ctrlKey: true, shiftKey: true }), false)).toBe(`Mod+Shift+5`);
        expect(chordFromEvent(keydown({ key: `~`, code: `Backquote`, ctrlKey: true, shiftKey: true }), false)).toBe(`Mod+Shift+\``);
        // The recorded chord round-trips back to the same keystroke.
        expect(matchesChord(`Mod+Shift+\``, keydown({ key: `~`, code: `Backquote`, ctrlKey: true, shiftKey: true }), false)).toBe(true);
    });
});

describe(`formatChord`, () => {
    it(`renders the native glyph stack on Apple`, () => {
        expect(formatChord(`Mod+Shift+P`, true)).toBe(`⇧⌘P`);
        expect(formatChord(`Ctrl+\``, true)).toBe(`⌃\``);
    });

    it(`spells and joins modifiers elsewhere`, () => {
        expect(formatChord(`Mod+Shift+P`, false)).toBe(`Ctrl+Shift+P`);
        expect(formatChord(`Mod+P`, false)).toBe(`Ctrl+P`);
    });

    it(`labels multi-word named keys readably`, () => {
        expect(formatChord(`Ctrl+PageDown`, false)).toBe(`Ctrl+PageDown`);
        expect(formatChord(`Ctrl+PageUp`, true)).toBe(`⌃PageUp`);
    });

    it(`draws the arrows as arrows`, () => {
        // Read in a 44px tooltip, where the arrow glyph has to be the whole word (the rail's walk chords).
        expect(formatChord(`Alt+ArrowUp`, false)).toBe(`Alt+↑`);
        expect(formatChord(`Alt+ArrowDown`, true)).toBe(`⌥↓`);
    });
});
