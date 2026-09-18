import { describe, expect, it } from "vitest";
import { editKeyBytes } from "./terminalEditKeys";

// Pins which chords are retyped and which stay xterm's, on the modifier flags a keydown carries.

const press = (key: string, modifiers: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}): KeyboardEvent =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers }) as KeyboardEvent;

describe(`editKeyBytes`, () => {
    it(`types a word kill for Ctrl+Backspace, which xterm would encode as ^H (one character)`, () => {
        expect(editKeyBytes(press(`Backspace`, { ctrlKey: true }), false)).toBe(`\x17`);
    });

    it(`leaves plain and Alt+Backspace alone: xterm's DEL and ESC DEL are already bound`, () => {
        expect(editKeyBytes(press(`Backspace`), false)).toBeUndefined();
        expect(editKeyBytes(press(`Backspace`, { altKey: true }), false)).toBeUndefined();
    });

    it(`names Home and End as the pane's terminfo does, not as xterm does`, () => {
        expect(editKeyBytes(press(`Home`), false)).toBe(`\x1b[1~`);
        expect(editKeyBytes(press(`End`), false)).toBe(`\x1b[4~`);
    });

    it(`leaves a modified Home to xterm, whose CSI carries the modifier`, () => {
        expect(editKeyBytes(press(`Home`, { ctrlKey: true }), false)).toBeUndefined();
        expect(editKeyBytes(press(`Home`, { shiftKey: true }), false)).toBeUndefined();
    });

    it(`claims the Cmd line edits on Apple only, where xterm sends nothing at all`, () => {
        expect(editKeyBytes(press(`ArrowLeft`, { metaKey: true }), true)).toBe(`\x01`);
        expect(editKeyBytes(press(`ArrowRight`, { metaKey: true }), true)).toBe(`\x05`);
        expect(editKeyBytes(press(`Backspace`, { metaKey: true }), true)).toBe(`\x15`);
        expect(editKeyBytes(press(`ArrowLeft`, { metaKey: true }), false)).toBeUndefined();
    });

    it(`never claims a chord carrying a second modifier`, () => {
        expect(editKeyBytes(press(`Backspace`, { ctrlKey: true, shiftKey: true }), false)).toBeUndefined();
        expect(editKeyBytes(press(`Backspace`, { ctrlKey: true, altKey: true }), false)).toBeUndefined();
        expect(editKeyBytes(press(`Backspace`, { ctrlKey: true, metaKey: true }), true)).toBeUndefined();
    });

    it(`passes an ordinary key straight through`, () => {
        expect(editKeyBytes(press(`a`), false)).toBeUndefined();
        expect(editKeyBytes(press(`ArrowLeft`, { ctrlKey: true }), false)).toBeUndefined();
    });
});
