import { composingKey, isMacTextChord, keyCap, letterOfCode, primaryHeld } from "@intentic/ui/keys";

// The kit's reading of a keystroke on each platform: which modifier is the app's, which chords a Mac text field
// answers itself, and when an Enter belongs to an input method instead of the field.

// SAFETY: the helpers read only the fields spelled out here, each defaulted.
const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: ``, code: ``, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...init }) as KeyboardEvent;

describe(`primaryHeld`, () => {
    it(`is ⌘ alone on a Mac and Ctrl alone elsewhere`, () => {
        expect(primaryHeld(key({ metaKey: true }), true)).toBe(true);
        expect(primaryHeld(key({ ctrlKey: true }), true)).toBe(false);
        expect(primaryHeld(key({ ctrlKey: true }), false)).toBe(true);
        expect(primaryHeld(key({ metaKey: true }), false)).toBe(false);
    });

    it(`reads both held at once as a different chord`, () => {
        expect(primaryHeld(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
        expect(primaryHeld(key({ metaKey: true, ctrlKey: true }), false)).toBe(false);
    });
});

describe(`composingKey`, () => {
    it(`claims a key while an input method composes, and the Enter Safari sends after it finished`, () => {
        expect(composingKey(key({ key: `Enter`, isComposing: true }))).toBe(true);
        expect(composingKey(key({ key: `Enter`, keyCode: 229 }))).toBe(true);
        expect(composingKey(key({ key: `Enter`, keyCode: 13 }))).toBe(false);
    });
});

describe(`isMacTextChord`, () => {
    it(`knows the caret chords a Mac text field answers`, () => {
        expect(isMacTextChord(key({ key: `ArrowUp`, altKey: true }))).toBe(true);
        expect(isMacTextChord(key({ key: `ArrowLeft`, metaKey: true, shiftKey: true }))).toBe(true);
        expect(isMacTextChord(key({ key: `Backspace`, metaKey: true }))).toBe(true);
        expect(isMacTextChord(key({ key: `a`, code: `KeyA`, ctrlKey: true }))).toBe(true);
        expect(isMacTextChord(key({ key: `k`, code: `KeyK`, ctrlKey: true }))).toBe(true);
    });

    it(`leaves app chords alone`, () => {
        expect(isMacTextChord(key({ key: `ArrowLeft`, metaKey: true, altKey: true }))).toBe(false);
        expect(isMacTextChord(key({ key: `x`, code: `KeyX`, ctrlKey: true, shiftKey: true }))).toBe(false);
        expect(isMacTextChord(key({ key: `w`, code: `KeyW`, ctrlKey: true }))).toBe(false);
        expect(isMacTextChord(key({ key: `p`, code: `KeyP`, metaKey: true }))).toBe(false);
        expect(isMacTextChord(key({ key: `ArrowUp` }))).toBe(false);
    });
});

describe(`letterOfCode`, () => {
    it(`names the letter a physical key sits on`, () => {
        expect(letterOfCode(`KeyH`)).toBe(`h`);
        expect(letterOfCode(`Digit1`)).toBeUndefined();
        expect(letterOfCode(undefined)).toBeUndefined();
    });
});

describe(`keyCap`, () => {
    it(`draws Apple's glyphs on a Mac and names the key elsewhere`, () => {
        expect(keyCap(`enter`, true)).toBe(`↩`);
        expect(keyCap(`escape`, true)).toBe(`⎋`);
        expect(keyCap(`enter`, false)).toBe(`Enter`);
        expect(keyCap(`escape`, false)).toBe(`Esc`);
        expect(keyCap(`space`, true)).toBe(`Space`);
    });
});
