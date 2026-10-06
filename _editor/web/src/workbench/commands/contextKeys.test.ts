// Needs jsdom: the per-event keys read the keystroke's target off the DOM.
import "@intentic/testing/dom";
import { commandContext } from "./contextKeys";

// A keydown as the window listener receives it: dispatched on the focused element, so `target` is that element.
const keydownOn = (element: Element): KeyboardEvent => {
    let caught: KeyboardEvent | undefined;
    window.addEventListener(`keydown`, (event) => (caught = event), { once: true });
    element.dispatchEvent(new KeyboardEvent(`keydown`, { key: `z`, ctrlKey: true, bubbles: true }));
    return caught!;
};

afterEach(() => {
    document.body.innerHTML = ``;
});

describe(`editableTarget`, () => {
    // Regression: the keymap's own copy of the check named INPUT and TEXTAREA only, so a chord gated on
    // `!editableTarget` (undo a delete, say) fired while a select had the keyboard.
    it(`is true for a focused select, like every other field`, () => {
        document.body.innerHTML = `<select><option>a</option></select><input><textarea></textarea>`;
        const fields = [`select`, `input`, `textarea`].map((tag) => commandContext(keydownOn(document.querySelector(tag)!))[`editableTarget`]);
        expect(fields).toEqual([true, true, true]);
    });

    it(`is false on a button or the page itself, where a chord is the shell's`, () => {
        document.body.innerHTML = `<button>go</button>`;
        expect(commandContext(keydownOn(document.querySelector(`button`)!))[`editableTarget`]).toBe(false);
        expect(commandContext(keydownOn(document.body))[`editableTarget`]).toBe(false);
    });
});
