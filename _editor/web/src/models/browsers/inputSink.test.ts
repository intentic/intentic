// The hidden field a live browser types through. What matters is that every way a person can produce text (a key, an
// IME, a dead key, an emoji panel, dictation, a phone's keyboard, a paste) reaches the page exactly once, and that what
// the input method owns is left to it. Events are real DOM events dispatched on a real field, wired as the stage wires
// them, so what the sink prevents, stops and empties is what a browser would see.
import type { InputMessage } from "./inputWire";
import { inputSink, type PasteEvent } from "./inputSink";

const fieldOver = (options: { pngOf?: (image: File) => Promise<string | undefined> } = {}) => {
    const sent: InputMessage[] = [];
    const commands: string[] = [];
    const sink = inputSink({ send: (message) => sent.push(message), isMac: false, ...options });
    const stage = document.createElement(`div`);
    const field = document.createElement(`textarea`);
    stage.append(field);
    field.addEventListener(`keydown`, (event) => sink.keydown(event, (command) => commands.push(command)));
    field.addEventListener(`beforeinput`, (event) => sink.beforeinput(event));
    field.addEventListener(`input`, (event) => sink.input(event));
    field.addEventListener(`compositionend`, (event) => sink.compositionend(event));
    // What reaches the window's own shortcuts: anything the sink did not stop.
    const bubbled: string[] = [];
    stage.addEventListener(`keydown`, (event) => bubbled.push(event.key));
    // Dispatches and answers whether the default went ahead.
    const press = (key: string, init: KeyboardEventInit = {}): boolean =>
        field.dispatchEvent(new KeyboardEvent(`keydown`, { key, bubbles: true, cancelable: true, ...init }));
    const edit = (inputType: string, data: string | null, isComposing = false): boolean =>
        field.dispatchEvent(new InputEvent(`beforeinput`, { inputType, data, isComposing, bubbles: true, cancelable: true }));
    const compose = (data: string): boolean => field.dispatchEvent(new CompositionEvent(`compositionend`, { data, bubbles: true }));
    return { sent, commands, bubbled, sink, field, press, edit, compose };
};

describe("keys", () => {
    test("a typed character is one keystroke of its own key, kept out of the field and off the editor's shortcuts", () => {
        const { sent, bubbled, press } = fieldOver();
        expect(press(`k`, { code: `KeyK` })).toBe(false);
        expect(sent).toEqual([{ type: `key`, key: `k`, code: `KeyK`, action: `press` }]);
        expect(bubbled).toEqual([]);
    });

    // Windows' AltGr is Ctrl+Alt: before, this was a chord for the host and typed nothing.
    test("AltGr on Windows types its letter", () => {
        const { sent, press } = fieldOver();
        press(`ą`, { code: `KeyA`, ctrlKey: true, altKey: true, modifierAltGraph: true });
        press(`@`, { code: `KeyQ`, ctrlKey: true, altKey: true });
        expect(sent).toEqual([
            { type: `key`, key: `ą`, code: `KeyA`, action: `press` },
            { type: `key`, key: `@`, code: `KeyQ`, action: `press` },
        ]);
    });

    test("a chord keeps its modifiers and the physical key", () => {
        const { sent, press } = fieldOver();
        press(`z`, { code: `KeyZ`, ctrlKey: true, shiftKey: true });
        expect(sent).toEqual([{ type: `key`, key: `z`, code: `KeyZ`, ctrl: true, shift: true, action: `press` }]);
    });

    test("the browser's own shortcut is the pane's command, never a keystroke", () => {
        const { sent, commands, press } = fieldOver();
        press(`=`, { code: `Equal`, ctrlKey: true });
        press(`p`, { code: `KeyP`, ctrlKey: true });
        expect(commands).toEqual([`zoomIn`, `print`]);
        expect(sent).toEqual([]);
    });

    // The IME's, the dead key's and the host's paste: left to the field and the window, untouched.
    test("what an input method or the host owns is neither sent nor prevented", () => {
        const { sent, bubbled, press } = fieldOver();
        expect([
            press(`Process`, { keyCode: 229 }),
            press(`Dead`, { code: `BracketLeft` }),
            press(`Enter`, { isComposing: true }),
            press(`v`, { code: `KeyV`, ctrlKey: true }),
        ]).toEqual([true, true, true, true]);
        expect(sent).toEqual([]);
        expect(bubbled).toEqual([`Process`, `Dead`, `Enter`, `v`]);
    });
});

describe("input methods", () => {
    // ´ then e: the dead key composes in the field and its result is committed once, whole.
    test("a dead key and its letter type one é", () => {
        const { sent, press, edit, compose } = fieldOver();
        press(`Dead`, { code: `Quote` });
        edit(`insertCompositionText`, `´`, true);
        press(`é`, { code: `KeyE`, isComposing: true });
        edit(`insertCompositionText`, `é`, true);
        compose(`é`);
        expect(sent).toEqual([{ type: `text`, text: `é` }]);
    });

    test("an IME's candidate is sent once when committed, not as it is drafted", () => {
        const { sent, press, edit, compose } = fieldOver();
        for (const draft of [`n`, `に`, `にほ`, `にほん`]) {
            press(`Process`, { keyCode: 229 });
            edit(`insertCompositionText`, draft, true);
        }
        press(`Enter`, { isComposing: true });
        compose(`日本`);
        expect(sent).toEqual([{ type: `text`, text: `日本` }]);
    });

    // A composition ended with nothing (Escape on a candidate) sends nothing.
    test("an abandoned composition sends nothing", () => {
        const { sent, compose } = fieldOver();
        compose(``);
        expect(sent).toEqual([]);
    });

    // The emoji panel, dictation and an Android keyboard insert text with no keydown that names it.
    test("text inserted without a keystroke is sent as text, and kept out of the field", () => {
        const { sent, press, edit } = fieldOver();
        press(`Unidentified`, { keyCode: 229 });
        expect(edit(`insertText`, `🎉`)).toBe(false);
        edit(`insertReplacementText`, `dictated words`);
        expect(sent).toEqual([
            { type: `text`, text: `🎉` },
            { type: `text`, text: `dictated words` },
        ]);
    });

    test("a phone keyboard's Backspace, Delete and Enter, which no keydown names, are keystrokes", () => {
        const { sent, edit } = fieldOver();
        for (const type of [`deleteContentBackward`, `deleteContentForward`, `deleteWordBackward`, `insertLineBreak`, `insertParagraph`]) {
            edit(type, null);
        }
        expect(sent).toEqual([
            { type: `key`, key: `Backspace`, code: `Backspace`, action: `press` },
            { type: `key`, key: `Delete`, code: `Delete`, action: `press` },
            { type: `key`, key: `Backspace`, code: `Backspace`, ctrl: true, action: `press` },
            { type: `key`, key: `Enter`, code: `Enter`, action: `press` },
            { type: `key`, key: `Enter`, code: `Enter`, action: `press` },
        ]);
    });

    test("the field is emptied after an edit lands, but never mid-composition", () => {
        const { field, compose } = fieldOver();
        field.value = `にほ`;
        field.dispatchEvent(new InputEvent(`input`, { inputType: `insertCompositionText`, data: `にほ`, isComposing: true }));
        expect(field.value).toBe(`にほ`);
        compose(`日本`);
        expect(field.value).toBe(``);
        field.value = `x`;
        field.dispatchEvent(new InputEvent(`input`, { inputType: `insertText`, data: `x` }));
        expect(field.value).toBe(``);
    });
});

describe("paste", () => {
    // A paste as the host delivers it: the clipboard answers by MIME type and lists its files.
    const pasteOf = (data: Readonly<Record<string, string>>, images: readonly File[] = []) => {
        const caught = { prevented: false };
        const event: PasteEvent = {
            clipboardData: {
                getData: (type) => data[type] ?? ``,
                items: images.map((file) => ({ kind: `file`, type: file.type, getAsFile: () => file })),
            },
            preventDefault: () => (caught.prevented = true),
        };
        return { event, caught };
    };

    test("the person's clipboard goes first, text and HTML, then the chord that pastes it", () => {
        const { sent, sink } = fieldOver();
        const { event, caught } = pasteOf({ "text/plain": `hello`, "text/html": `<b>hello</b>` });
        sink.paste(event);
        expect(sent).toEqual([
            { type: `clipboard`, content: { text: `hello`, html: `<b>hello</b>` } },
            { type: `key`, key: `v`, code: `KeyV`, ctrl: true, action: `press` },
        ]);
        expect(caught.prevented).toBe(true);
    });

    test("an image is carried as a PNG, and what is typed while it is read lands after the paste", async () => {
        let finish: (png: string) => void = () => undefined;
        const { sent, sink, press } = fieldOver({ pngOf: () => new Promise((resolve) => (finish = resolve)) });
        sink.paste(pasteOf({}, [new File([`img`], `shot.png`, { type: `image/png` })]).event);
        press(`a`, { code: `KeyA` });
        expect(sent).toEqual([]);
        finish(`iVBORw0K`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(sent).toEqual([
            { type: `clipboard`, content: { png: `iVBORw0K` } },
            { type: `key`, key: `v`, code: `KeyV`, ctrl: true, action: `press` },
            { type: `key`, key: `a`, code: `KeyA`, action: `press` },
        ]);
    });

    test("an empty clipboard pastes nothing and leaves the event alone", () => {
        const { sent, sink } = fieldOver();
        const { event, caught } = pasteOf({});
        sink.paste(event);
        expect(sent).toEqual([]);
        expect(caught.prevented).toBe(false);
    });

    test("the field's own paste edit is refused, so the text never lands in it", () => {
        const { sent, edit } = fieldOver();
        expect(edit(`insertFromPaste`, null)).toBe(false);
        expect(sent).toEqual([]);
    });
});
