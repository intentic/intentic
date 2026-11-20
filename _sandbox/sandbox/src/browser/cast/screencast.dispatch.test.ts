import { dispatchInput, dispatchWheel, type InputSession, wheelEvent } from "./screencast.js";

// What the person's input becomes on the page's CDP session: a scroll by its exact pixel deltas at the pointer, and a
// paste inserted at once. Driven over a recording session, so this needs no browser.

// Every CDP call the dispatch made, in order.
const recording = () => {
    const calls: { method: string; params: unknown }[] = [];
    const session = {
        send: async (method: string, params?: unknown) => {
            calls.push({ method, params });
            return {};
        },
    };
    // SAFETY: the dispatch only ever calls `send` and never reads what it answers.
    return { calls, session: session as InputSession };
};

describe("scrolling", () => {
    // Rounding to X's 53 px notches scrolled a trackpad nothing and a big wheel step in jumps.
    test("a wheel scrolls the page by its exact deltas, fractions and all, at the pointer", async () => {
        const { calls, session } = recording();
        await dispatchInput(session, { type: "mouse", action: "wheel", x: 300, y: 200, buttons: 0, deltaX: 0.5, deltaY: 12.25 });

        expect(calls).toEqual([
            {
                method: "Input.dispatchMouseEvent",
                params: { type: "mouseWheel", x: 300, y: 200, modifiers: 0, buttons: 0, deltaX: 0.5, deltaY: 12.25 },
            },
        ]);
    });

    // The video path's picture is the display's pixels, twice the page's CSS pixels on a scale-2 display.
    test("a wheel in the picture's pixels lands in the page's CSS pixels", async () => {
        const { calls, session } = recording();
        await dispatchWheel(session, { type: "mouse", action: "wheel", x: 600, y: 400, deltaY: 100, ctrl: true }, 2);

        expect(calls).toEqual([
            { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 300, y: 200, modifiers: 2, buttons: 0, deltaX: 0, deltaY: 50 } },
        ]);
    });

    test("held buttons and modifiers ride on a wheel, for a drag that scrolls and Ctrl+wheel zoom", () => {
        expect(wheelEvent({ type: "mouse", action: "wheel", x: 1, y: 2, buttons: 1, shift: true, deltaY: 3 })).toEqual({
            type: "mouseWheel",
            x: 1,
            y: 2,
            modifiers: 8,
            buttons: 1,
            deltaX: 0,
            deltaY: 3,
        });
    });
});

describe("pasting", () => {
    // Typed through xdotool at 12 ms a character, a 5,000-character paste took a minute and held every key behind it.
    test("pasted text is inserted whole in one call, however long", async () => {
        const { calls, session } = recording();
        const text = "lorem ipsum\n".repeat(1_000);
        await dispatchInput(session, { type: "text", text });

        expect(calls).toEqual([{ method: "Input.insertText", params: { text } }]);
    });
});
