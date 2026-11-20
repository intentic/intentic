// The input layer speaks the media socket's vocabulary; today's browser view socket takes a narrower one, and the
// adapter is what keeps a scroll, a held modifier, a paste and a lost focus meaning the same thing on it.
import type { BrowserViewClientMessage } from "@intentic/sandbox-contract/browser-wire";
import { mediaInput, viewInput, type InputMessage } from "./inputWire";

const overView = (options: Parameters<typeof viewInput>[1] = {}) => {
    const sent: BrowserViewClientMessage[] = [];
    const port = viewInput((message) => sent.push(message), options);
    return { sent, send: (...messages: InputMessage[]) => messages.forEach(port.send) };
};

describe("the media socket", () => {
    test("takes the layer's messages as they are", () => {
        const sent: unknown[] = [];
        const port = mediaInput((message) => sent.push(message));
        port.send({ type: `scroll`, x: 1, y: 2, dx: 0.25, dy: -3.5 });
        port.send({ type: `releaseAll` });
        expect(sent).toEqual([{ type: `scroll`, x: 1, y: 2, dx: 0.25, dy: -3.5 }, { type: `releaseAll` }]);
    });
});

describe("the browser view socket", () => {
    // Fractions and all: the daemon scrolls by exactly this much through CDP.
    test("a scroll is a wheel event with the exact pixel deltas, and what is held rides along", () => {
        const { sent, send } = overView();
        send({ type: `mouse`, action: `down`, x: 5, y: 6, button: 0, buttons: 1 });
        send({ type: `scroll`, x: 10, y: 20, dx: 0.5, dy: 12.25 });
        expect(sent.at(-1)).toEqual({ type: `mouse`, action: `wheel`, x: 10, y: 20, buttons: 1, deltaX: 0.5, deltaY: 12.25 });
    });

    test("a modifier put down around a scroll is a flag on it, and gone once it comes up", () => {
        const { sent, send } = overView();
        send(
            { type: `key`, key: `Control`, code: `ControlLeft`, action: `down` },
            { type: `scroll`, x: 1, y: 1, dx: 0, dy: -100 },
            { type: `key`, key: `Control`, code: `ControlLeft`, action: `up` },
            { type: `scroll`, x: 1, y: 1, dx: 0, dy: -100 },
        );
        expect(sent).toEqual([
            { type: `mouse`, action: `wheel`, x: 1, y: 1, buttons: 0, deltaX: 0, deltaY: -100, ctrl: true },
            { type: `mouse`, action: `wheel`, x: 1, y: 1, buttons: 0, deltaX: 0, deltaY: -100 },
        ]);
    });

    // Input.insertText types it exactly, whatever the sandbox's keyboard layout; a keystroke would type the key the
    // display's layout puts there.
    test("a typed character is inserted, and a chord or a control key is a keystroke", () => {
        const { sent, send } = overView();
        send(
            { type: `key`, key: `ą`, code: `KeyA`, action: `press` },
            { type: `key`, key: `a`, code: `KeyA`, ctrl: true, action: `press` },
            { type: `key`, key: `Enter`, code: `Enter`, action: `press` },
            { type: `key`, key: ` `, code: `Space`, action: `press` },
        );
        expect(sent).toEqual([
            { type: `text`, text: `ą` },
            { type: `key`, key: `a`, ctrl: true },
            { type: `key`, key: `Enter` },
            { type: `key`, key: ` ` },
        ]);
    });

    test("only whole keystrokes travel: a key's release alone is nothing here", () => {
        const { sent, send } = overView();
        send({ type: `key`, key: `x`, code: `KeyX`, action: `up` });
        expect(sent).toEqual([]);
    });

    test("while the find bar has the keyboard, keys and text go to the display", () => {
        const { sent, send } = overView({ raw: () => true });
        send({ type: `key`, key: `q`, action: `press` }, { type: `key`, key: `Escape`, action: `press` }, { type: `text`, text: `終わり` });
        expect(sent).toEqual([
            { type: `text`, text: `q`, raw: true },
            { type: `key`, key: `Escape`, raw: true },
            { type: `text`, text: `終わり`, raw: true },
        ]);
    });

    // The Ctrl+V after it would paste the sandbox's own clipboard, which is not what the person copied.
    test("a paste is its text, inserted at once, and the chord after it is not sent", () => {
        const { sent, send } = overView();
        const long = `x`.repeat(10_000);
        send({ type: `clipboard`, content: { text: long, html: `<b>x</b>` } }, { type: `key`, key: `v`, code: `KeyV`, ctrl: true, action: `press` });
        expect(sent).toEqual([{ type: `text`, text: long }]);
    });

    test("a copy or cut chord is handed to the selection round trip instead of sent", () => {
        const copied: unknown[] = [];
        const { sent, send } = overView({ copy: (chord) => copied.push(chord) });
        send(
            { type: `key`, key: `c`, code: `KeyC`, ctrl: true, action: `press` },
            { type: `key`, key: `X`, code: `KeyX`, ctrl: true, action: `press` },
        );
        expect(copied).toEqual([
            { type: `key`, key: `c`, ctrl: true },
            { type: `key`, key: `x`, ctrl: true },
        ]);
        expect(sent).toEqual([]);
    });

    // Focus lost mid-drag: without this the remote button stays down and the next move drags.
    test("letting go releases every button this viewer pressed, where the pointer last was", () => {
        const { sent, send } = overView();
        send(
            { type: `mouse`, action: `down`, x: 40, y: 50, button: 0, buttons: 1 },
            { type: `mouse`, action: `down`, x: 41, y: 51, button: 2, buttons: 3 },
            { type: `key`, key: `Shift`, action: `down` },
            { type: `releaseAll` },
            { type: `mouse`, action: `move`, x: 42, y: 52, buttons: 0 },
        );
        expect(sent.slice(2)).toEqual([
            { type: `mouse`, action: `up`, x: 41, y: 51, button: 2, buttons: 1 },
            { type: `mouse`, action: `up`, x: 41, y: 51, button: 0, buttons: 0 },
            // The Shift put down before is let go too.
            { type: `mouse`, action: `move`, x: 42, y: 52, buttons: 0 },
        ]);
    });

    test("letting go with nothing held sends nothing", () => {
        const { sent, send } = overView();
        send(
            { type: `mouse`, action: `down`, x: 1, y: 1, button: 0, buttons: 1 },
            { type: `mouse`, action: `up`, x: 1, y: 1, button: 0, buttons: 0 },
        );
        send({ type: `releaseAll` });
        expect(sent).toHaveLength(2);
    });
});
