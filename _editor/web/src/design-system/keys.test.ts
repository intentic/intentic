import { composingKey, installModEnterSubmit, isMacTextChord, isModEnter, isSendKey, keyCap, letterOfCode, primaryHeld } from "@intentic/ui/keys";

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

describe(`isModEnter`, () => {
    it(`is Enter under Ctrl or ⌘, and nothing else held`, () => {
        expect(isModEnter(key({ key: `Enter`, ctrlKey: true }))).toBe(true);
        expect(isModEnter(key({ key: `Enter`, metaKey: true }))).toBe(true);
        expect(isModEnter(key({ key: `Enter` }))).toBe(false);
        expect(isModEnter(key({ key: `Enter`, ctrlKey: true, shiftKey: true }))).toBe(false);
        expect(isModEnter(key({ key: `Enter`, metaKey: true, altKey: true }))).toBe(false);
        expect(isModEnter(key({ key: `a`, ctrlKey: true }))).toBe(false);
    });
});

describe(`installModEnterSubmit`, () => {
    let uninstall: () => void = () => undefined;
    beforeAll(() => {
        uninstall = installModEnterSubmit();
    });
    afterAll(() => uninstall());
    afterEach(() => {
        document.body.innerHTML = ``;
    });

    // A form whose submits are counted, each with the button that sent it.
    const mount = (html: string): { form: HTMLFormElement; sent: (HTMLElement | null)[] } => {
        document.body.innerHTML = html;
        const form = document.querySelector(`form`);
        if (form === null) {
            throw new Error(`no form`);
        }
        const sent: (HTMLElement | null)[] = [];
        form.addEventListener(`submit`, (event) => {
            event.preventDefault();
            sent.push(event.submitter);
        });
        return { form, sent };
    };
    const press = (selector: string, init: KeyboardEventInit): KeyboardEvent => {
        const event = new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true, cancelable: true, ...init });
        document.querySelector(selector)?.dispatchEvent(event);
        return event;
    };

    it(`submits a one-line field's form through its default button, as Enter would`, () => {
        const { sent } = mount(`<form><input id="field"><button type="button">Other</button><button id="go">Go</button></form>`);
        const event = press(`#field`, { ctrlKey: true });
        expect(sent.map((button) => button?.id)).toEqual([`go`]);
        expect(event.defaultPrevented).toBe(true);
    });

    it(`submits from a textarea, where Enter is a new line`, () => {
        const { sent } = mount(`<form><textarea id="field"></textarea><button>Save</button></form>`);
        press(`#field`, { metaKey: true });
        press(`#field`, {});
        expect(sent).toHaveLength(1);
    });

    it(`submits a form that has no button of its own`, () => {
        const { sent } = mount(`<form><input id="field"></form>`);
        press(`#field`, { ctrlKey: true });
        expect(sent).toEqual([null]);
    });

    it(`holds a form whose default button is disabled`, () => {
        const { sent } = mount(`<form><input id="field"><button disabled>Go</button></form>`);
        const event = press(`#field`, { ctrlKey: true });
        expect(sent).toHaveLength(0);
        expect(event.defaultPrevented).toBe(false);
    });

    it(`leaves the chord to a field that answered it, and to an input method still composing`, () => {
        const { sent } = mount(`<form><textarea id="field"></textarea><button>Send</button></form>`);
        const field = document.querySelector(`#field`);
        const own = (event: Event): void => event.preventDefault();
        field?.addEventListener(`keydown`, own);
        press(`#field`, { ctrlKey: true });
        field?.removeEventListener(`keydown`, own);
        press(`#field`, { ctrlKey: true, isComposing: true });
        expect(sent).toHaveLength(0);
    });

    it(`does nothing outside a form, on a button, or for another chord`, () => {
        const { sent } = mount(`<input id="loose"><form><input id="field"><input id="press" type="button"><button>Go</button></form>`);
        press(`#loose`, { ctrlKey: true });
        press(`#press`, { ctrlKey: true });
        press(`#field`, { ctrlKey: true, shiftKey: true });
        press(`#field`, { altKey: true, metaKey: true });
        expect(sent).toHaveLength(0);
    });
});

describe(`isSendKey`, () => {
    afterEach(() => {
        document.body.innerHTML = ``;
    });

    // What a listener on the panel hears when the chord is pressed in `selector`.
    const heard = (selector: string, init: KeyboardEventInit = { ctrlKey: true }): boolean => {
        let sends = false;
        const panel = document.querySelector(`#panel`);
        const listen = (event: Event): void => {
            sends = event instanceof KeyboardEvent && isSendKey(event);
        };
        panel?.addEventListener(`keydown`, listen);
        document.querySelector(selector)?.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true, cancelable: true, ...init }));
        panel?.removeEventListener(`keydown`, listen);
        return sends;
    };

    it(`is the panel's chord from its own fields, and from a panel inside a form`, () => {
        document.body.innerHTML = `<form><div id="panel"><textarea id="rules"></textarea></div></form>`;
        expect(heard(`#rules`)).toBe(true);
        expect(heard(`#rules`, { metaKey: true })).toBe(true);
        expect(heard(`#rules`, {})).toBe(false);
    });

    it(`leaves a form inside the panel its own submit`, () => {
        document.body.innerHTML = `<div id="panel"><form><input id="host"></form><textarea id="rules"></textarea></div>`;
        expect(heard(`#host`)).toBe(false);
        expect(heard(`#rules`)).toBe(true);
    });

    it(`leaves a chord a field below already answered`, () => {
        document.body.innerHTML = `<div id="panel"><textarea id="rules"></textarea></div>`;
        document.querySelector(`#rules`)?.addEventListener(`keydown`, (event) => event.preventDefault());
        expect(heard(`#rules`)).toBe(false);
    });
});
