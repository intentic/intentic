// What the owner's hands become on the desktop's wire. Each case is one decision the daemon cannot undo: a click aimed
// at the letterbox instead of the picture, a double click replayed as a triple, a keystroke left with the host or
// stolen from it.
import "@intentic/testing/dom";
import { keyMessage, pointerMessage, WHEEL_NOTCH, wheelGauge } from "./desktopInput";

// The desktop's own size (agent-desktop.ts DESKTOP_SIZE): 8:5.
const WIDTH = 1280;
const HEIGHT = 800;

// The picture element, measuring as the given box on the page.
const picture = (left: number, top: number, width: number, height: number): HTMLElement => {
    const canvas = document.createElement(`canvas`);
    canvas.getBoundingClientRect = () => new DOMRect(left, top, width, height);
    return canvas;
};
const pointerAt = (clientX: number, clientY: number, button = 0, detail = 0): MouseEvent => new MouseEvent(`pointerdown`, { clientX, clientY, button, detail });

describe("pointer", () => {
    test("a move names a point on the desktop and no button", () => {
        expect(pointerMessage(`move`, pointerAt(640, 400), picture(0, 0, WIDTH, HEIGHT), WIDTH, HEIGHT)).toEqual({ type: `mouse`, action: `move`, x: 640, y: 400 });
    });

    // The canvas is object-contain'd: a wide pane letterboxes left and right, and a half-size one halves every coordinate.
    test("a press is aimed at the picture inside the letterbox, in the desktop's own pixels", () => {
        const wide = picture(100, 50, 1280, 400);
        // The picture is 640x400, centred: its left edge is 320px into the box.
        expect(pointerMessage(`down`, pointerAt(100 + 320, 50), wide, WIDTH, HEIGHT)).toEqual({ type: `mouse`, action: `down`, x: 0, y: 0, button: 0 });
        expect(pointerMessage(`up`, pointerAt(100 + 320 + 320, 50 + 200, 2), wide, WIDTH, HEIGHT)).toEqual({
            type: `mouse`,
            action: `up`,
            x: 640,
            y: 400,
            button: 2,
        });
        // A press in the letterbox lands on the nearest edge rather than off the desktop.
        expect(pointerMessage(`down`, pointerAt(100 + 1279, 50 + 399), wide, WIDTH, HEIGHT)).toEqual({ type: `mouse`, action: `down`, x: WIDTH, y: 798, button: 0 });
    });

    // The daemon replays clickCount n as n presses; the second press of a double click reports detail 2, which would
    // add two more presses to the one already made.
    test("a second press of a double click is one press, not a count", () => {
        expect(pointerMessage(`down`, pointerAt(10, 10, 0, 2), picture(0, 0, WIDTH, HEIGHT), WIDTH, HEIGHT)).toEqual({
            type: `mouse`,
            action: `down`,
            x: 10,
            y: 10,
            button: 0,
        });
    });

    // A canvas still hidden measures 0x0; answering the origin would click the desktop's top-left corner.
    test("a picture with no box sends nothing", () => {
        expect(pointerMessage(`down`, pointerAt(10, 10), picture(0, 0, 0, 0), WIDTH, HEIGHT)).toBeUndefined();
    });
});

describe("wheel", () => {
    const wheelOf = (deltaY: number, deltaMode = 0, deltaX = 0): WheelEvent => new WheelEvent(`wheel`, { deltaX, deltaY, deltaMode });

    test("a mouse's notch is one notch", () => {
        expect(wheelGauge()(wheelOf(WHEEL_NOTCH))).toEqual({ deltaX: 0, deltaY: WHEEL_NOTCH });
        expect(wheelGauge()(wheelOf(-WHEEL_NOTCH))).toEqual({ deltaX: 0, deltaY: -WHEEL_NOTCH });
    });

    // The daemon drops what is left of a notch, so a trackpad's small deltas each scrolled nothing at all.
    test("a trackpad's small deltas add up to a notch, and the rest is kept for the next", () => {
        const gauge = wheelGauge();
        expect(gauge(wheelOf(20))).toBeUndefined();
        expect(gauge(wheelOf(20))).toBeUndefined();
        expect(gauge(wheelOf(20))).toEqual({ deltaX: 0, deltaY: WHEEL_NOTCH });
        // 7 left over, so 46 more is the next notch exactly.
        expect(gauge(wheelOf(45))).toBeUndefined();
        expect(gauge(wheelOf(1))).toEqual({ deltaX: 0, deltaY: WHEEL_NOTCH });
    });

    test("a wheel that counts in lines scrolls a notch per three", () => {
        expect(wheelGauge()(wheelOf(3, WheelEvent.DOM_DELTA_LINE))).toEqual({ deltaX: 0, deltaY: WHEEL_NOTCH });
        expect(wheelGauge()(wheelOf(1, WheelEvent.DOM_DELTA_LINE))).toBeUndefined();
    });

    test("sideways is its own axis", () => {
        expect(wheelGauge()(wheelOf(0, 0, -2 * WHEEL_NOTCH))).toEqual({ deltaX: -2 * WHEEL_NOTCH, deltaY: 0 });
    });
});

describe("keys", () => {
    const press = (key: string, held: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent(`keydown`, { key, ...held });

    test("a character is typed rather than pressed", () => {
        expect(keyMessage(press(`k`))).toEqual({ type: `text`, text: `k` });
        // Shift is already in the character.
        expect(keyMessage(press(`K`, { shiftKey: true }))).toEqual({ type: `text`, text: `K` });
        expect(keyMessage(press(`ł`))).toEqual({ type: `text`, text: `ł` });
    });

    // Windows reports AltGr as Ctrl+Alt; the @ it made on a Polish or German layout is a character, not a chord.
    test("a character made with AltGr is typed, not chorded", () => {
        expect(keyMessage(press(`@`, { ctrlKey: true, altKey: true, modifierAltGraph: true }))).toEqual({ type: `text`, text: `@` });
    });

    test("control keys and space are pressed by their DOM names, with Shift", () => {
        expect(keyMessage(press(`Enter`))).toEqual({ type: `key`, key: `Enter` });
        expect(keyMessage(press(`ArrowLeft`, { shiftKey: true }))).toEqual({ type: `key`, key: `ArrowLeft`, shift: true });
        expect(keyMessage(press(` `))).toEqual({ type: `key`, key: ` ` });
        expect(keyMessage(press(`Escape`))).toEqual({ type: `key`, key: `Escape` });
        expect(keyMessage(press(`F5`))).toEqual({ type: `key`, key: `F5` });
    });

    // The desktop has no chrome of ours: Ctrl+C in its terminal is an interrupt, Ctrl+T a new terminal tab.
    test("every chord goes to the desktop, Cmd as Ctrl, lower-cased with Shift as a flag", () => {
        expect(keyMessage(press(`c`, { ctrlKey: true }))).toEqual({ type: `key`, key: `c`, ctrl: true });
        expect(keyMessage(press(`t`, { metaKey: true }))).toEqual({ type: `key`, key: `t`, ctrl: true });
        expect(keyMessage(press(`Z`, { ctrlKey: true, shiftKey: true }))).toEqual({ type: `key`, key: `z`, ctrl: true, shift: true });
        expect(keyMessage(press(`f`, { altKey: true }))).toEqual({ type: `key`, key: `f`, alt: true });
        expect(keyMessage(press(`Tab`, { altKey: true }))).toEqual({ type: `key`, key: `Tab`, alt: true });
    });

    // Paste stays with the host, whose paste event carries the owner's own clipboard; the desktop's is the sandbox's.
    test("paste, a bare modifier and a half-composed character stay with the host", () => {
        expect(keyMessage(press(`v`, { ctrlKey: true }))).toBeUndefined();
        expect(keyMessage(press(`V`, { metaKey: true, shiftKey: true }))).toBeUndefined();
        expect(keyMessage(press(`Shift`, { shiftKey: true }))).toBeUndefined();
        expect(keyMessage(press(`Control`, { ctrlKey: true }))).toBeUndefined();
        expect(keyMessage(press(`Dead`))).toBeUndefined();
        expect(keyMessage(press(`a`, { isComposing: true }))).toBeUndefined();
    });
});
